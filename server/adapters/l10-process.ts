/**
 * L10 — process and diagnostics primitives (design v3 §g.1-4; L10 seam-review
 * items 1 + 3). The closed child env (l10-env.ts) and the frozen argv
 * (l10-routes.ts) are the inputs; this module owns the spawn, the
 * diagnostics shape, the 2-permit lock, and the exit-code handling.
 *
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, openSync, closeSync, existsSync, readFileSync, unlinkSync, writeFileSync, renameSync, linkSync, statSync, readdirSync, realpathSync } from "node:fs";
import { join, delimiter, dirname, resolve, basename } from "node:path";
import { AdapterFailure } from "./types";
import { assertSpawnTripwire, configEnvRefusedNames, L10_REFUSED_SINGLES } from "./l10-env";
import { assertValidModelLiteral, buildL10Argv, L10_FROZEN_LITERALS } from "./l10-routes";
import { getResolvedL10Binaries } from "./config";

/**
 * B2 (rework 1): frozen absolute Python interpreter path. The slice-1
 * closed child PATH (/usr/bin:/bin:/usr/sbin:/sbin) contains no `python`,
 * so every bare `spawn("python", …)` was ENOENT at all three Python spawn
 * sites (the security reviewer measured both poles). The discipline §a froze for the
 * CLIs applies to the interpreter: resolve once at module load against
 * the operator's real PATH, freeze the absolute path, spawn argv[0]
 * absolute — the closed child env PATH then cannot break the spawn.
 */
export function resolvePythonAbs(pathEnv: string): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = `${dir}/python`;
    try { if (existsSync(candidate)) return candidate; } catch { /* next */ }
  }
  return null;
}

/** Frozen absolute interpreter path, or null when unresolvable. Spawn
 *  sites fail closed with MODEL_UNAVAILABLE on null, never ENOENT. */
export const PYTHON_ABS: string | null = resolvePythonAbs(process.env.PATH ?? "");

export const L10_MAX_OUTPUT_BYTES = 64_000;
export const L10_CLAUDE_USAGE_WALL_EXIT = 75;
export const L10_CLAUDE_AUTH_BLOCKED_EXIT = 76;
export const L10_CLAUDE_MAX_CONCURRENT = 2;
export const L10_CLAUDE_PERMIT_DIR = "/tmp/l10/permits";

/**
 * Resolve the realpath of a path, handling cases where the full path does not exist
 * yet by resolving the nearest existing ancestor and appending remaining segments.
 */
export function resolveRealPath(p: string): string {
  const resolved = resolve(p);
  let current = resolved;
  const parts: string[] = [];
  while (current && current !== "/" && !existsSync(current)) {
    parts.unshift(basename(current));
    current = dirname(current);
  }
  const baseReal = existsSync(current) ? realpathSync(current) : current;
  return parts.length > 0 ? resolve(baseReal, ...parts) : baseReal;
}

/**
 * Rework 20 Item E: Guard permit pool directory against shared production pool
 * by comparing resolved realpaths (handles /private/tmp, trailing slashes, dot-dot).
 */
export function isSharedClaudePermitDir(poolDir: string | undefined): boolean {
  if (!poolDir) return false;
  return resolveRealPath(poolDir) === resolveRealPath(L10_CLAUDE_PERMIT_DIR);
}
export const L10_PROMPT_STDIN_PATH = "/dev/stdin";
export const L10_MAX_KILLSET_SIZE = 32;
export const L10_MAX_SNAPSHOT_GAP_MS = 500;

let cachedRunnerPgid: number | null = null;
export function getRunnerPgid(): number | null {
  if (cachedRunnerPgid !== null) return cachedRunnerPgid;
  try {
    const raw = execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const p = parseInt(raw, 10);
    if (!isNaN(p) && p > 0) cachedRunnerPgid = p;
  } catch {}
  return cachedRunnerPgid;
}

let cachedRunnerSid: number | null = null;
export function getRunnerSid(): number | null {
  if (cachedRunnerSid !== null) return cachedRunnerSid;
  try {
    const raw = execFileSync("/bin/ps", ["-o", "sess=", "-p", String(process.pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const s = parseInt(raw, 10);
    if (!isNaN(s) && s > 0) cachedRunnerSid = s;
  } catch {}
  if (cachedRunnerSid === null) {
    try {
      const out = execFileSync("python3", ["-c", "import os; print(os.getsid(0))"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      const s = parseInt(out, 10);
      if (!isNaN(s) && s > 0) cachedRunnerSid = s;
    } catch {}
  }
  return cachedRunnerSid;
}

/**
 * R4 (rework 7b): safe process-group kill guard.
 * Group-kill ONLY when pgid === childPid AND pgid is not the runner's own group or pid.
 * Never signal a negative group that matches or contains process.pid.
 * Fails closed if runner pgid cannot be determined.
 */
export function isSafeToKillGroup(pgid: number | null, childPid: number | null): boolean {
  if (pgid === null || pgid <= 1 || childPid === null || childPid <= 1) return false;
  if (pgid !== childPid) return false;
  if (pgid === process.pid) return false;
  const runnerPgid = getRunnerPgid();
  if (runnerPgid === null || pgid === runnerPgid) return false;
  return true;
}

export type KillSetContext = {
  runnerPid?: number;
  runnerPgid?: number;
  runnerSid?: number;
  runnerUid?: number;
  maxCap?: number;
};

/**
 * G1: Kill-set guard (defense-in-depth against invalid ownership predicates).
 * Teardown never signals:
 *   (a) a pid outside the current uid
 *   (b) the runner's own pid, session or process group
 *   (c) more pids than a small cap (L10_MAX_KILLSET_SIZE = 32)
 *
 * Checks the whole planned set before sending the first signal.
 * On any violation, throws AdapterFailure("KILLSET_REFUSED", reason).
 */
function assertSafeKillSetPolicy(
  pids: number[],
  ctx?: KillSetContext,
  metaReader?: (pids: number[]) => Map<number, { uid: number; pgid: number; sess: number }>,
): void {
  const uniquePids = Array.from(new Set(pids.map((p) => Math.abs(p))));
  const maxCap = ctx?.maxCap ?? L10_MAX_KILLSET_SIZE;
  if (uniquePids.length > maxCap) {
    throw new AdapterFailure(
      "KILLSET_REFUSED",
      `kill-set refused: count ${uniquePids.length} exceeds max cap ${maxCap}`,
      null,
      false,
    );
  }

  const runnerPid = ctx?.runnerPid ?? process.pid;
  const runnerPgid = (ctx && "runnerPgid" in ctx && ctx.runnerPgid !== undefined) ? ctx.runnerPgid : getRunnerPgid();
  const runnerSid = (ctx && "runnerSid" in ctx && ctx.runnerSid !== undefined) ? ctx.runnerSid : getRunnerSid();
  const runnerUid = ctx?.runnerUid ?? (typeof process.getuid === "function" ? process.getuid() : 501);

  if (runnerPgid === null) {
    throw new AdapterFailure("KILLSET_REFUSED", "kill-set refused: runner process group could not be determined", null, false);
  }
  if (runnerSid === null) {
    throw new AdapterFailure("KILLSET_REFUSED", "kill-set refused: runner session could not be determined", null, false);
  }

  // 1. Static PID check
  for (const pid of uniquePids) {
    if (pid <= 1) {
      throw new AdapterFailure("KILLSET_REFUSED", `kill-set refused: cannot signal system pid ${pid} (count ${uniquePids.length})`, null, false);
    }
    if (pid === runnerPid) {
      throw new AdapterFailure("KILLSET_REFUSED", `kill-set refused: cannot signal runner pid ${pid} (count ${uniquePids.length})`, null, false);
    }
    if (pid === runnerPgid) {
      throw new AdapterFailure("KILLSET_REFUSED", `kill-set refused: cannot signal runner process group leader ${pid} (count ${uniquePids.length})`, null, false);
    }
    if (runnerSid > 0 && pid === runnerSid) {
      throw new AdapterFailure("KILLSET_REFUSED", `kill-set refused: cannot signal runner session leader ${pid} (count ${uniquePids.length})`, null, false);
    }
  }

  if (uniquePids.length === 0) return;

  // 2. Query process table for uid, pgid, sess
  let metaMap: Map<number, { uid: number; pgid: number; sess: number }>;
  let psError: Error | null = null;
  const customReader = metaReader;
  if (customReader) {
    try {
      metaMap = customReader(uniquePids);
    } catch (e: any) {
      throw new AdapterFailure("KILLSET_REFUSED", `kill-set refused: metadata reader failure: ${e.message}`, null, false);
    }
  } else {
    metaMap = new Map();
    try {
      const out = execFileSync("/bin/ps", ["-o", "pid=,uid=,pgid=,sess=", "-p", uniquePids.join(",")], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const line of out.trim().split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4) {
          const p = parseInt(parts[0], 10);
          const u = parseInt(parts[1], 10);
          const pg = parseInt(parts[2], 10);
          const s = parseInt(parts[3], 10);
          if (!isNaN(p)) {
            metaMap.set(p, { uid: u, pgid: pg, sess: s });
          }
        }
      }
    } catch (err: any) {
      psError = err;
    }
    if (psError) {
      for (const pid of uniquePids) {
        try {
          const out = execFileSync("/bin/ps", ["-o", "pid=,uid=,pgid=,sess=", "-p", String(pid)], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          });
          const line = out.trim().split("\n")[0];
          if (line) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 4) {
              const p = parseInt(parts[0], 10);
              const u = parseInt(parts[1], 10);
              const pg = parseInt(parts[2], 10);
              const s = parseInt(parts[3], 10);
              if (!isNaN(p)) {
                metaMap.set(p, { uid: u, pgid: pg, sess: s });
              }
            }
          }
        } catch {}
      }
    }
  }

  function isPidAbsent(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return false;
    } catch (err: any) {
      if (err?.code === "ESRCH") return true;
      return false;
    }
  }

  // 3. Inspect metadata for each pid
  for (const pid of uniquePids) {
    const meta = metaMap.get(pid);
    if (!meta) {
      if (customReader) {
        throw new AdapterFailure(
          "KILLSET_REFUSED",
          `kill-set refused: pid ${pid} has no verified metadata (count ${uniquePids.length})`,
          null,
          false,
        );
      }
      if (isPidAbsent(pid)) {
        continue;
      }
      if (psError) {
        throw new AdapterFailure(
          "KILLSET_REFUSED",
          `kill-set refused: /bin/ps metadata read failure: ${psError.message}`,
          null,
          false,
        );
      }
      throw new AdapterFailure(
        "KILLSET_REFUSED",
        `kill-set refused: pid ${pid} has no verified metadata (count ${uniquePids.length})`,
        null,
        false,
      );
    }
    if (meta.uid !== runnerUid) {
      throw new AdapterFailure(
        "KILLSET_REFUSED",
        `kill-set refused: pid ${pid} has foreign uid ${meta.uid} !== runner uid ${runnerUid} (count ${uniquePids.length})`,
        null,
        false,
      );
    }
      if (meta.pgid === runnerPgid) {
        throw new AdapterFailure(
          "KILLSET_REFUSED",
          `kill-set refused: pid ${pid} belongs to runner pgid ${runnerPgid} (count ${uniquePids.length})`,
          null,
          false,
        );
      }
      if (runnerSid > 0 && meta.sess === runnerSid) {
        throw new AdapterFailure(
          "KILLSET_REFUSED",
          `kill-set refused: pid ${pid} belongs to runner session ${runnerSid} (count ${uniquePids.length})`,
          null,
          false,
        );
      }
  }
}

/**
 * Production kill-set guard: accepts pids only.
 * Always enforces real runner identity, real ps table lookup, and L10_MAX_KILLSET_SIZE.
 */
export function assertSafeKillSet(pids: number[]): void {
  assertSafeKillSetPolicy(pids);
}

/**
 * Test entry point for validating guard policy with mock contexts and readers.
 */
export function assertSafeKillSetForTest(
  pids: number[],
  ctx?: KillSetContext,
  metaReader?: (pids: number[]) => Map<number, { uid: number; pgid: number; sess: number }>,
): void {
  assertSafeKillSetPolicy(pids, ctx, metaReader);
}

export type SignalFn = (target: number, signal: NodeJS.Signals | 0) => boolean | void;

export type L10Diagnostic = {
  exitCode: number;
  stdoutBytes: number;
  stdoutSha256: string;
  stderrBytes: number;
  stderrSha256: string;
  stdoutFirstLine?: string; // v3 L172: no first line retained by default
};

/**
 * Compute a sha256 over a buffer.
 */
export function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Spawn a child with the closed env, the frozen argv, the prompt on STDIN
 * (v3 §g.3 R5), and a strict output cap. The diagnostic is a static shape
 * (exit code + byte counts + sha256); model stdout/stderr never enter a
 * diagnostic message (v3 §g.2). Returns the captured text only on success,
 * the diagnostic on every exit. The caller decides what to do with the
 * diagnostic (record to recordAdapter, etc.).
 */
export interface SpawnL10ChildOptions {
  argv: string[];
  cwd: string;
  childEnv: Readonly<Record<string, string>>;
  promptText: string;
  timeoutMs: number;
  cancelSignal: { cancelled: () => boolean };
}

export interface SpawnL10ChildTestOptions extends SpawnL10ChildOptions {
  signalFn?: SignalFn;
}

export async function spawnL10Child(
  opts: SpawnL10ChildOptions,
): Promise<{ stdoutText: string; stderrText: string; diagnostic: L10Diagnostic; childPid: number }> {
  assertNoUnsupportedOptions(opts, PRODUCTION_SPAWN_OPTIONS, "spawnL10Child");
  const r = await spawnL10ChildInner(
    {
      argv: opts.argv,
      cwd: opts.cwd,
      childEnv: opts.childEnv,
      promptText: opts.promptText,
      timeoutMs: opts.timeoutMs,
      cancelSignal: opts.cancelSignal,
    },
    undefined,
    undefined,
    undefined,
    undefined,
  );
  return { stdoutText: r.stdoutText, stderrText: r.stderrText, diagnostic: r.diagnostic, childPid: r.childPid };
}

export async function spawnL10ChildForTest(
  opts: SpawnL10ChildTestOptions,
): Promise<{ stdoutText: string; stderrText: string; diagnostic: L10Diagnostic }> {
  const { signalFn, ...prodOpts } = opts;
  const r = await spawnL10ChildInner(
    {
      argv: prodOpts.argv,
      cwd: prodOpts.cwd,
      childEnv: prodOpts.childEnv,
      promptText: prodOpts.promptText,
      timeoutMs: prodOpts.timeoutMs,
      cancelSignal: prodOpts.cancelSignal,
    },
    undefined,
    undefined,
    undefined,
    { signalFn },
  );
  return { stdoutText: r.stdoutText, stderrText: r.stderrText, diagnostic: r.diagnostic };
}

/**
 * R4 (rework 5): find all descendant processes recursively using ps.
 * Sweeps child processes even if they created their own session (setsid)
 * while the parent or child was active.
 */
export function findDescendants(parentPid: number): number[] {
  try {
    const out = execFileSync("/bin/ps", ["-axo", "pid,ppid"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    const tree = new Map<number, number[]>();
    for (const line of out.trim().split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const p = parseInt(parts[0], 10);
        const pp = parseInt(parts[1], 10);
        if (!isNaN(p) && !isNaN(pp)) {
          if (!tree.has(pp)) tree.set(pp, []);
          tree.get(pp)!.push(p);
        }
      }
    }
    const descendants: number[] = [];
    const queue = [parentPid];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const children = tree.get(curr) ?? [];
      for (const ch of children) {
        descendants.push(ch);
        queue.push(ch);
      }
    }
    return descendants;
  } catch {
    return [];
  }
}

/**
 * R4 (rework 7): find all processes in a process group by pgid.
 * Allows tracking descendants across reparenting even without TMPDIR.
 */
export function findPidsByPgid(targetPgid: number): number[] | null {
  try {
    const out = execFileSync("/bin/ps", ["-axo", "pid,pgid"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pids: number[] = [];
    for (const line of out.trim().split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const pid = parseInt(parts[0], 10);
        const pgid = parseInt(parts[1], 10);
        if (!isNaN(pid) && !isNaN(pgid) && pgid === targetPgid && pid !== process.pid) {
          pids.push(pid);
        }
      }
    }
    return pids;
  } catch {
    return null;
  }
}

export function verifyProcessIdentity(
  pid: number,
  expected: { lstart?: string; cmd?: string } | undefined,
): boolean {
  if (!expected || !expected.lstart) return false;
  try {
    const raw = execFileSync("/bin/ps", ["-o", "lstart=,command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!raw) return false;
    const match = raw.match(/^([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s*(.*)$/);
    if (!match) return false;
    const actualLstart = match[1].trim();
    const actualCmd = match[2] ? match[2].trim() : "";
    if (actualLstart !== expected.lstart.trim()) return false;
    if (expected.cmd && (!actualCmd || !actualCmd.includes(expected.cmd.trim()))) return false;
    return true;
  } catch {
    return false;
  }
}

export function recordProcessIdentity(
  pid: number,
  store: Map<number, { lstart?: string; cmd?: string }>,
): void {
  if (store.has(pid)) return;
  let lstart = "";
  let cmd = "";
  try {
    const raw = execFileSync("/bin/ps", ["-o", "lstart=,command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (raw) {
      const match = raw.match(/^([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s*(.*)$/);
      if (match) {
        lstart = match[1].trim();
        cmd = match[2] ? match[2].trim() : "";
      }
    }
  } catch {}
  store.set(pid, { lstart, cmd });
}

/**
 * Rework 13 (N5/N6): ONE helper for formatting poison recording outcome.
 * Returns "" if poison was recorded (or no permit), or "; poison not recorded: <reason>" if recording failed.
 */
export function poisonNote(
  permit: { poison?: (reason: string) => any } | undefined | null,
  reason: string,
): string {
  if (!permit || typeof permit.poison !== "function") return "";
  try {
    const res = permit.poison(reason);
    if (res && typeof res === "object" && res.recorded === false) {
      return `; poison not recorded: ${res.reason ?? "unknown"}`;
    }
  } catch {
    return "; poison not recorded: unknown";
  }
  return "";
}

export function checkGroupSignalSafety(
  pgid: number,
  childPid: number | null,
  accumulatedDescendants: Map<number, { lstart?: string; cmd?: string }> | undefined,
  approvedTargets: Set<number>,
  permit?: { poison: (reason: string) => any },
): boolean {
  if (!isSafeToKillGroup(pgid, childPid)) return false;
  const leaderMeta = accumulatedDescendants?.get(childPid!);
  if (!verifyProcessIdentity(childPid!, leaderMeta)) return false;

  const currentMembers = findPidsByPgid(pgid);
  if (currentMembers === null) {
    const note = poisonNote(permit, "held-by-killset-refusal");
    const err = new AdapterFailure(
      "KILLSET_REFUSED",
      `kill-set refused: unable to read process group members for pgid ${pgid}${note}`,
      null,
      false,
    );
    if (note) err.poisonNotRecorded = note.replace(/^;\s*poison not recorded:\s*/, "");
    throw err;
  }
  for (const m of currentMembers) {
    if (!approvedTargets.has(m)) {
      const note = poisonNote(permit, "held-by-killset-refusal");
      const err = new AdapterFailure(
        "KILLSET_REFUSED",
        `kill-set refused: unapproved member ${m} in group ${pgid} discovered before group signal${note}`,
        null,
        false,
      );
      if (note) err.poisonNotRecorded = note.replace(/^;\s*poison not recorded:\s*/, "");
      throw err;
    }
  }
  return true;
}

/**
 * B3 (rework 1): the Claude-route entry — the ONLY sanctioned adapter
 * spawn path for a Claude child. Acquires one shared permit BEFORE spawn
 * and releases it in finally on every outcome (success, error, timeout,
 * cancellation), per v3 §g.4 ("Acquire before reservation/spawn; hold
 * until child and descendants exit; release once in finally"). The
 * harness calls this same function (v3 L118: same modules).
 */
export interface TeardownProcessTreeOptions {
  childPid: number | null;
  childPgid: number | null;
  trackedDescendants: Set<number>;
  accumulatedDescendants?: Map<number, { lstart?: string; cmd?: string }>;
  permit?: { poison: (reason: string) => any; release?: () => void };
}

export interface TeardownProcessTreeTestOptions extends TeardownProcessTreeOptions {
  signalFn?: SignalFn;
  timeoutMs?: number;
}

const PRODUCTION_TEARDOWN_OPTIONS: readonly (string | symbol)[] = Object.freeze([
  "childPid",
  "childPgid",
  "trackedDescendants",
  "accumulatedDescendants",
  "permit",
]);

const PRODUCTION_SPAWN_CLAUDE_OPTIONS: readonly (string | symbol)[] = Object.freeze([
  "argv",
  "cwd",
  "childEnv",
  "promptText",
  "timeoutMs",
  "cancelSignal",
  "runId",
  "permitPool",
]);

const PRODUCTION_SPAWN_OPTIONS: readonly (string | symbol)[] = Object.freeze([
  "argv",
  "cwd",
  "childEnv",
  "promptText",
  "timeoutMs",
  "cancelSignal",
]);

function assertNoUnsupportedOptions(
  opts: unknown,
  allowlist: readonly (string | symbol)[],
  entryName: string,
): void {
  if (typeof opts !== "object" || opts === null) {
    throw new AdapterFailure(
      "UNSUPPORTED_OPTION_ON_PRODUCTION_ENTRY",
      `options passed to ${entryName} must be a plain object`,
      null,
      false,
    );
  }
  const proto = Object.getPrototypeOf(opts);
  if (proto !== Object.prototype && proto !== null) {
    throw new AdapterFailure(
      "UNSUPPORTED_OPTION_ON_PRODUCTION_ENTRY",
      `options passed to ${entryName} must be a plain object, but prototype is not Object.prototype or null`,
      null,
      false,
    );
  }
  for (const key of Reflect.ownKeys(opts)) {
    if (!allowlist.includes(key)) {
      const keyStr = typeof key === "symbol" ? key.toString() : String(key);
      throw new AdapterFailure(
        "UNSUPPORTED_OPTION_ON_PRODUCTION_ENTRY",
        `${keyStr} is not accepted by ${entryName}; it would be ignored and the real signalling path used. Use ${entryName}ForTest.`,
        null,
        false,
      );
    }
  }
}

export async function teardownProcessTree(opts: TeardownProcessTreeOptions): Promise<boolean> {
  assertNoUnsupportedOptions(opts, PRODUCTION_TEARDOWN_OPTIONS, "teardownProcessTree");
  return teardownProcessTreeInner(
    {
      childPid: opts.childPid,
      childPgid: opts.childPgid,
      trackedDescendants: opts.trackedDescendants,
      accumulatedDescendants: opts.accumulatedDescendants,
      permit: opts.permit,
    },
    undefined,
    undefined,
  );
}

export async function teardownProcessTreeForTest(
  opts: TeardownProcessTreeTestOptions,
  guard?: (pids: number[]) => void,
): Promise<boolean> {
  const { signalFn, timeoutMs, ...prodOpts } = opts;
  return teardownProcessTreeInner(
    {
      childPid: prodOpts.childPid,
      childPgid: prodOpts.childPgid,
      trackedDescendants: prodOpts.trackedDescendants,
      accumulatedDescendants: prodOpts.accumulatedDescendants,
      permit: prodOpts.permit,
    },
    guard,
    { signalFn, timeoutMs },
  );
}

async function teardownProcessTreeInner(
  opts: TeardownProcessTreeOptions,
  guard?: (pids: number[]) => void,
  internal?: { signalFn?: SignalFn; timeoutMs?: number },
): Promise<boolean> {
  const planned = new Set<number>();
  if (opts.childPid !== null) planned.add(opts.childPid);
  for (const d of Array.from(opts.trackedDescendants)) planned.add(d);
  if (opts.childPgid !== null && isSafeToKillGroup(opts.childPgid, opts.childPid)) {
    const groupMembers = findPidsByPgid(opts.childPgid);
    if (groupMembers === null) {
      const note = poisonNote(opts.permit, "held-by-killset-refusal");
      const err = new AdapterFailure(
        "KILLSET_REFUSED",
        `kill-set refused: unable to read process group members for pgid ${opts.childPgid}${note}`,
        null,
        false,
      );
      if (note) err.poisonNotRecorded = note.replace(/^;\s*poison not recorded:\s*/, "");
      throw err;
    }
    for (const d of groupMembers) {
      if (d !== opts.childPid) planned.add(d);
    }
  }

  // G1: validate the WHOLE planned set BEFORE sending the first signal!
  // Production guard ALWAYS runs first; custom test guard is strictly additive.
  try {
    assertSafeKillSet(Array.from(planned));
    if (guard) {
      guard(Array.from(planned));
    }
  } catch (err: any) {
    const note = poisonNote(opts.permit, "held-by-killset-refusal");
    if (note) {
      if (err instanceof AdapterFailure) {
        err.poisonNotRecorded = note.replace(/^;\s*poison not recorded:\s*/, "");
        if (!err.message.includes(note)) err.message += note;
      } else if (err && typeof err === "object") {
        err.poisonNotRecorded = note.replace(/^;\s*poison not recorded:\s*/, "");
        if (typeof err.message === "string" && !err.message.includes(note)) err.message += note;
      }
    }
    throw err;
  }

  const isAlive = (target: number): boolean => {
    if (internal?.signalFn) {
      const res = internal.signalFn(target, 0);
      return res === true;
    }
    try {
      process.kill(target, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };

  const doKill = internal?.signalFn ?? ((t: number, s: NodeJS.Signals | 0) => {
    try {
      process.kill(t, s);
      return true;
    } catch {
      return false;
    }
  });

  const startTeardown = Date.now();
  let teardownConfirmed = false;
  const timeoutMs = internal?.timeoutMs ?? 5000;

  const approvedTargets = new Set(planned);
  let iteration = 0;

  while (true) {
    const checkUnapproved = () => {
      for (const d of Array.from(opts.trackedDescendants)) {
        if (!approvedTargets.has(d)) {
          const note = poisonNote(opts.permit, "held-by-killset-refusal");
          const err = new AdapterFailure(
            "KILLSET_REFUSED",
            `kill-set refused: unapproved target ${d} discovered after guard check${note}`,
            null,
            false,
          );
          if (note) err.poisonNotRecorded = note.replace(/^;\s*poison not recorded:\s*/, "");
          throw err;
        }
      }
    };
    checkUnapproved();

    if (iteration === 0) {
      if (opts.childPgid !== null) {
        if (checkGroupSignalSafety(opts.childPgid, opts.childPid, opts.accumulatedDescendants, approvedTargets, opts.permit)) {
          try { doKill(-opts.childPgid, "SIGKILL"); } catch {}
        }
      }
      if (opts.childPid !== null) {
        try { doKill(opts.childPid, "SIGKILL"); } catch {}
      }
      for (const d of Array.from(approvedTargets)) {
        if (d === opts.childPid) continue;
        try { doKill(d, "SIGKILL"); } catch {}
      }
    } else {
      // Retry pass: re-signal live targets only if identity verified
      if (opts.childPgid !== null) {
        if (isAlive(-opts.childPgid)) {
          if (checkGroupSignalSafety(opts.childPgid, opts.childPid, opts.accumulatedDescendants, approvedTargets, opts.permit)) {
            try { doKill(-opts.childPgid, "SIGKILL"); } catch {}
          }
        }
      }
      if (opts.childPid !== null && isAlive(opts.childPid)) {
        const meta = opts.accumulatedDescendants?.get(opts.childPid);
        const verified = verifyProcessIdentity(opts.childPid, meta);
        if (verified) {
          try { doKill(opts.childPid, "SIGKILL"); } catch {}
        }
      }
      for (const d of Array.from(approvedTargets)) {
        if (d === opts.childPid) continue;
        if (isAlive(d)) {
          const meta = opts.accumulatedDescendants?.get(d);
          const verified = verifyProcessIdentity(d, meta);
          if (verified) {
            try { doKill(d, "SIGKILL"); } catch {}
          }
        }
      }
    }

    let dead = opts.childPid !== null ? !isAlive(opts.childPid) : true;
    let pgidDead = (opts.childPgid !== null && isSafeToKillGroup(opts.childPgid, opts.childPid)) ? !isAlive(-opts.childPgid) : true;
    let descendantsDead = true;
    for (const d of Array.from(approvedTargets)) {
      if (d === opts.childPid) continue;
      if (isAlive(d)) descendantsDead = false;
    }
    checkUnapproved();

    if (dead && pgidDead && descendantsDead) {
      teardownConfirmed = true;
      break;
    }
    if (Date.now() - startTeardown > timeoutMs) {
      break; // Avoid spinning past timeout; unconfirmed teardown will poison permit
    }
    iteration++;
    await new Promise((r) => setTimeout(r, 20));
  }

  if (!teardownConfirmed) {
    const note = poisonNote(opts.permit, "held-by-unconfirmed-teardown");
    const err = new AdapterFailure(
      "TEARDOWN_UNCONFIRMED",
      `unconfirmed child or descendant teardown after ${timeoutMs}ms SIGKILL timeout; permit withheld${note}`,
      null,
      false,
    );
    if (note) err.poisonNotRecorded = note.replace(/^;\s*poison not recorded:\s*/, "");
    throw err;
  }

  return true;
}

export interface SpawnClaudeL10ChildOptions {
  argv: string[];
  cwd: string;
  childEnv: Readonly<Record<string, string>>;
  promptText: string;
  timeoutMs: number;
  cancelSignal: { cancelled: () => boolean };
  runId: string;
  permitPool?: L10PermitPool;
}

export interface SpawnClaudeL10ChildTestOptions extends SpawnClaudeL10ChildOptions {
  signalFn?: SignalFn;
  maxSnapshotGapMs?: number;
  skipExitSnapshot?: boolean;
  onSnapshot?: (phase: "poller" | "exit", seen: Set<number>) => void;
  teardownTimeoutMs?: number;
}

const CLAUDE_SLOTS = Object.freeze(["continuity", "collaboration", "security"] as const);

/**
 * R17 P1 + C1 Part 1 & Rework 18 C: Element-for-element Claude contract gate.
 * The production entry accepts ONLY argv deep-equal to the frozen buildL10Argv contract
 * for an allowed Claude slot {continuity, collaboration, security}.
 * Production requires argv[0] to be exactly the configured Claude binary
 * (AGENT_COMMONS_CLAUDE_BIN; same frozen value as buildL10Argv reads — brief rev 2 C2).
 * Test entry allows substituting argv[0] with a fixture binary; the rest of argv must still
 * match the contract element-for-element.
 * Any other model, foreign binary, prepended/appended flag, or short contract is refused
 * with MODEL_UNAVAILABLE before permit acquire and child spawn.
 */
export function assertClaudeModelGate(argv: string[], isTest = false): string {
  if (!Array.isArray(argv) || argv.length < 4) {
    throw new AdapterFailure("MODEL_UNAVAILABLE", "missing model literal", null, false);
  }
  const bin = argv[0];
  if (typeof bin !== "string" || bin.trim() === "") {
    throw new AdapterFailure("MODEL_UNAVAILABLE", "missing binary in argv", null, false);
  }
  if (!isTest) {
    const configured = getResolvedL10Binaries().claude;
    const expected = configured.status === "enabled" ? configured.path : null;
    if (expected === null || bin !== expected) {
      const reason = configured.status === "enabled" ? `expected ${expected}` : `claude bin ${configured.reason}`;
      throw new AdapterFailure("MODEL_UNAVAILABLE", `invalid claude binary: ${bin} (${reason})`, null, false);
    }
  }

  for (const slotId of CLAUDE_SLOTS) {
    const contract = buildL10Argv({ slotId });
    if (argv.length !== contract.length) continue;
    let matches = true;
    const startIdx = isTest ? 1 : 0;
    for (let i = startIdx; i < contract.length; i++) {
      if (argv[i] !== contract[i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return contract[3];
    }
  }

  throw new AdapterFailure("MODEL_UNAVAILABLE", "argv does not match frozen Claude contract", null, false);
}

/**
 * Rework 18 C: Element-for-element Codex contract gate.
 * The production entry accepts ONLY argv deep-equal to the frozen buildL10Argv contract
 * for slot governance ("gpt-6.1-sol").
 * Production requires argv[0] to be exactly the configured Codex binary
 * (AGENT_COMMONS_CODEX_BIN; same frozen value as buildL10Argv reads — brief rev 2 C2).
 * Test entry allows substituting argv[0] with a fixture binary; the rest of argv must still
 * match the contract element-for-element.
 */
export function assertCodexModelGate(argv: string[], isTest = false): string {
  if (!Array.isArray(argv) || argv.length < 4) {
    throw new AdapterFailure("MODEL_UNAVAILABLE", "missing model literal", null, false);
  }
  const bin = argv[0];
  if (typeof bin !== "string" || bin.trim() === "") {
    throw new AdapterFailure("MODEL_UNAVAILABLE", "missing binary in argv", null, false);
  }
  if (!isTest) {
    const configured = getResolvedL10Binaries().codex;
    const expected = configured.status === "enabled" ? configured.path : null;
    if (expected === null || bin !== expected) {
      const reason = configured.status === "enabled" ? `expected ${expected}` : `codex bin ${configured.reason}`;
      throw new AdapterFailure("MODEL_UNAVAILABLE", `invalid codex binary: ${bin} (${reason})`, null, false);
    }
  }

  const contract = buildL10Argv({ slotId: "governance" });
  if (argv.length !== contract.length) {
    throw new AdapterFailure("MODEL_UNAVAILABLE", "argv does not match frozen Codex contract", null, false);
  }
  const startIdx = isTest ? 1 : 0;
  for (let i = startIdx; i < contract.length; i++) {
    if (argv[i] !== contract[i]) {
      throw new AdapterFailure("MODEL_UNAVAILABLE", "argv does not match frozen Codex contract", null, false);
    }
  }

  return contract[3];
}

export async function spawnClaudeL10Child(
  opts: SpawnClaudeL10ChildOptions,
): Promise<{ stdoutText: string; stderrText: string; diagnostic: L10Diagnostic; childPid: number }> {
  assertNoUnsupportedOptions(opts, PRODUCTION_SPAWN_CLAUDE_OPTIONS, "spawnClaudeL10Child");
  assertClaudeModelGate(opts.argv, false);
  return spawnClaudeL10ChildInner(
    {
      argv: opts.argv,
      cwd: opts.cwd,
      childEnv: opts.childEnv,
      promptText: opts.promptText,
      timeoutMs: opts.timeoutMs,
      cancelSignal: opts.cancelSignal,
      runId: opts.runId,
      permitPool: opts.permitPool,
    },
    undefined,
  );
}

export async function spawnClaudeL10ChildForTest(
  opts: SpawnClaudeL10ChildTestOptions,
): Promise<{ stdoutText: string; stderrText: string; diagnostic: L10Diagnostic; childPid: number; observerError?: unknown }> {
  const { signalFn, maxSnapshotGapMs, skipExitSnapshot, onSnapshot, teardownTimeoutMs, ...prodOpts } = opts;
  assertClaudeModelGate(prodOpts.argv, true);
  if (!prodOpts.permitPool || isSharedClaudePermitDir(prodOpts.permitPool.poolDir)) {
    throw new AdapterFailure(
      "SECURITY_VIOLATION",
      "spawnClaudeL10ChildForTest requires an explicit private permitPool; using the shared pool in tests is prohibited",
      null,
      false,
    );
  }
  return spawnClaudeL10ChildInner(
    {
      argv: prodOpts.argv,
      cwd: prodOpts.cwd,
      childEnv: prodOpts.childEnv,
      promptText: prodOpts.promptText,
      timeoutMs: prodOpts.timeoutMs,
      cancelSignal: prodOpts.cancelSignal,
      runId: prodOpts.runId,
      permitPool: prodOpts.permitPool,
    },
    {
      signalFn,
      maxSnapshotGapMs,
      skipExitSnapshot,
      onSnapshot,
      teardownTimeoutMs,
    },
  );
}

const PRODUCTION_SPAWN_CODEX_OPTIONS: readonly string[] = Object.freeze([
  "argv",
  "cwd",
  "childEnv",
  "promptText",
  "timeoutMs",
  "cancelSignal",
] as const);

export interface SpawnCodexL10ChildOptions {
  argv: string[];
  cwd: string;
  childEnv: Readonly<Record<string, string>>;
  promptText: string;
  timeoutMs: number;
  cancelSignal: { cancelled: () => boolean };
}

export interface SpawnCodexL10ChildTestOptions extends SpawnCodexL10ChildOptions {
  signalFn?: SignalFn;
}

export async function spawnCodexL10Child(
  opts: SpawnCodexL10ChildOptions,
): Promise<{ stdoutText: string; stderrText: string; diagnostic: L10Diagnostic; childPid: number }> {
  assertNoUnsupportedOptions(opts, PRODUCTION_SPAWN_CODEX_OPTIONS, "spawnCodexL10Child");
  assertCodexModelGate(opts.argv, false);
  const r = await spawnL10ChildInner(
    {
      argv: opts.argv,
      cwd: opts.cwd,
      childEnv: opts.childEnv,
      promptText: opts.promptText,
      timeoutMs: opts.timeoutMs,
      cancelSignal: opts.cancelSignal,
    },
    undefined,
    undefined,
    undefined,
    undefined,
  );
  return { stdoutText: r.stdoutText, stderrText: r.stderrText, diagnostic: r.diagnostic, childPid: r.childPid };
}

export async function spawnCodexL10ChildForTest(
  opts: SpawnCodexL10ChildTestOptions,
): Promise<{ stdoutText: string; stderrText: string; diagnostic: L10Diagnostic; childPid: number }> {
  const { signalFn, ...prodOpts } = opts;
  assertCodexModelGate(prodOpts.argv, true);
  const r = await spawnL10ChildInner(
    {
      argv: prodOpts.argv,
      cwd: prodOpts.cwd,
      childEnv: prodOpts.childEnv,
      promptText: prodOpts.promptText,
      timeoutMs: prodOpts.timeoutMs,
      cancelSignal: prodOpts.cancelSignal,
    },
    undefined,
    undefined,
    undefined,
    { signalFn },
  );
  return { stdoutText: r.stdoutText, stderrText: r.stderrText, diagnostic: r.diagnostic, childPid: r.childPid };
}

export function safeErrorText(e: unknown): string {
  try {
    if (e instanceof Error && typeof e.message === "string") {
      return e.message;
    }
  } catch {}
  try {
    return String(e);
  } catch {
    return "<unprintable thrown value>";
  }
}

export function safeError(e: unknown): Error {
  try {
    if (e instanceof Error) return e;
  } catch {}
  try {
    return new Error(safeErrorText(e));
  } catch {
    return new Error("<unprintable thrown value>");
  }
}

async function spawnClaudeL10ChildInner(
  opts: SpawnClaudeL10ChildOptions,
  testKnobs?: {
    signalFn?: SignalFn;
    maxSnapshotGapMs?: number;
    skipExitSnapshot?: boolean;
    onSnapshot?: (phase: "poller" | "exit", seen: Set<number>) => void;
    teardownTimeoutMs?: number;
  },
): Promise<{ stdoutText: string; stderrText: string; diagnostic: L10Diagnostic; childPid: number; observerError?: unknown }> {
  // R17 P1 + C1 Part 1: Unconditional Claude model gate before permit acquire and spawn
  assertClaudeModelGate(opts.argv, testKnobs !== undefined);

  const pool = opts.permitPool ?? sharedClaudePermitPool;
  // R4 (rework 5): cancellation checked BEFORE acquire
  if (opts.cancelSignal.cancelled()) {
    throw new AdapterFailure("TRANSPORT_ERROR", "cancelled before permit acquire", null, false);
  }
  const permit = await pool.acquire(opts.runId, {
    deadlineMs: opts.timeoutMs,
    cancelSignal: opts.cancelSignal,
  });
  let childPid: number | null = null;
  let childPgid: number | null = null;
  const trackedDescendants = new Set<number>();
  const beforePids = new Set<number>();
  let poller: { stop: () => void } | null = null;
  let observerError: Error | undefined;
  let resToReturn: { stdoutText: string; stderrText: string; diagnostic: L10Diagnostic; childPid: number } | null = null;

  // R4b: positive ancestry containment across snapshot gap
  const maxGap = testKnobs?.maxSnapshotGapMs ?? L10_MAX_SNAPSHOT_GAP_MS;
  let childObservedInSnapshot = false;
  let childObservedCount = 0;
  let lastSnapshotWithChild = 0;
  let firstDeadSampleTime = 0;
  let lastSnapshotTime = 0;
  let maxObservedGapMs = 0;
  let pollerError: Error | null = null;

  try {
    const out = execFileSync("/bin/ps", ["-axo", "pid"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.trim().split("\n").slice(1)) {
      const p = parseInt(line.trim(), 10);
      if (!isNaN(p)) beforePids.add(p);
    }
  } catch {}

  const accumulatedDescendants = new Map<number, { lstart?: string; cmd?: string }>();
  const childSessions = new Set<string>();

  const recordDescendantMeta = (pid: number) => {
    recordProcessIdentity(pid, accumulatedDescendants);
  };

  const snapshotAncestry = () => {
    if (childPid === null) return;
    const now = Date.now();
    if (lastSnapshotTime > 0) {
      const gap = now - lastSnapshotTime;
      if (gap > maxObservedGapMs) maxObservedGapMs = gap;
    }
    lastSnapshotTime = now;

    const out = execFileSync("/bin/ps", ["-axo", "pid,ppid,pgid,sess,state"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const tree = new Map<number, number[]>();
    const infoMap = new Map<number, { ppid: number; pgid: number; sess: string }>();
    for (const line of out.trim().split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5) {
        const p = parseInt(parts[0], 10);
        const pp = parseInt(parts[1], 10);
        const pg = parseInt(parts[2], 10);
        const s = parts[3];
        const st = parts[4];
        const isDead = st.startsWith("Z");
        if (!isNaN(p) && p !== process.pid && !isDead) {
          infoMap.set(p, { ppid: pp, pgid: pg, sess: s });
          if (!tree.has(pp)) tree.set(pp, []);
          tree.get(pp)!.push(p);
        }
      }
    }

    if (infoMap.has(childPid)) {
      childObservedInSnapshot = true;
      childObservedCount++;
      lastSnapshotWithChild = now;
    } else if (childObservedInSnapshot && firstDeadSampleTime === 0) {
      firstDeadSampleTime = now;
    }

    const childInf = infoMap.get(childPid);
    if (childInf) childSessions.add(childInf.sess);

    const queue = [childPid, ...Array.from(accumulatedDescendants.keys())];
    const visited = new Set<number>([childPid]);
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const kids = tree.get(curr) ?? [];
      for (const k of kids) {
        if (!visited.has(k) && k !== process.pid) {
          visited.add(k);
          queue.push(k);
          const inf = infoMap.get(k);
          if (inf) {
            recordDescendantMeta(k);
            childSessions.add(inf.sess);
            trackedDescendants.add(k);
          }
        }
      }
    }

    for (const [p, inf] of Array.from(infoMap.entries())) {
      if (p !== process.pid && p !== childPid) {
        const isSessionMatch = childSessions.size > 0 && childSessions.has(inf.sess) && inf.sess !== "0";
        const isGroupMatch = childPgid !== null && isSafeToKillGroup(childPgid, childPid) && inf.pgid === childPgid;
        if (isSessionMatch || isGroupMatch) {
          recordDescendantMeta(p);
          trackedDescendants.add(p);
        }
      }
    }
  };

  let spawnError: any = null;
  try {
    // R4 (rework 5): cancellation checked BEFORE spawn
    if (opts.cancelSignal.cancelled()) {
      throw new AdapterFailure("TRANSPORT_ERROR", "cancelled before spawn", null, false);
    }

    const r = await spawnL10ChildInner(
      {
        argv: opts.argv,
        cwd: opts.cwd,
        childEnv: opts.childEnv,
        promptText: opts.promptText,
        timeoutMs: opts.timeoutMs,
        cancelSignal: opts.cancelSignal,
        permit,
      },
      (pid) => {
        childPid = pid;
        childPgid = pid;
        recordDescendantMeta(pid);
        try {
          snapshotAncestry();
        } catch (err: unknown) {
          try {
            pollerError = safeError(err);
          } catch {
            pollerError = new Error("<unprintable thrown value>");
          }
        }
      let running = true;
      poller = {
        stop: () => {
          running = false;
        },
      };
      (async () => {
        try {
          while (running) {
            if (childPid !== null) {
              try {
                process.kill(childPid, 0);
              } catch {
                break;
              }
            }
            snapshotAncestry();
            if (testKnobs?.onSnapshot) {
              testKnobs.onSnapshot("poller", new Set(trackedDescendants));
            }
            if (!running) break;
            await new Promise((r) => setImmediate(r));
          }
        } catch (err: unknown) {
          try {
            pollerError = safeError(err);
          } catch {
            pollerError = new Error("<unprintable thrown value>");
          }
          running = false;
        }
      })().catch((err: unknown) => {
        try {
          pollerError = safeError(err);
        } catch {
          pollerError = new Error("<unprintable thrown value>");
        }
        running = false;
      });
    }, trackedDescendants, accumulatedDescendants, { signalFn: testKnobs?.signalFn });
    childPid = r.childPid;
    resToReturn = { stdoutText: r.stdoutText, stderrText: r.stderrText, diagnostic: r.diagnostic, childPid: r.childPid };
  } catch (err: any) {
    spawnError = err;
  } finally {
    if (poller) (poller as any).stop();
    if (!testKnobs?.skipExitSnapshot) {
      try {
        snapshotAncestry();
      } catch (err: unknown) {
        try {
          if (!pollerError) pollerError = safeError(err);
        } catch {
          if (!pollerError) pollerError = new Error("<unprintable thrown value>");
        }
      }
    }
    if (childPid !== null) {
      if (!testKnobs?.skipExitSnapshot) {
        for (const d of findDescendants(childPid)) {
          trackedDescendants.add(d);
          recordDescendantMeta(d);
        }
        if (childPgid !== null && isSafeToKillGroup(childPgid, childPid)) {
          const groupMembers = findPidsByPgid(childPgid);
          if (groupMembers) {
            for (const d of groupMembers) {
              if (d !== childPid) {
                trackedDescendants.add(d);
                recordDescendantMeta(d);
              }
            }
          }
        }
        for (const d of Array.from(trackedDescendants)) {
          for (const gd of findDescendants(d)) {
            trackedDescendants.add(gd);
            recordDescendantMeta(gd);
          }
        }
        if (testKnobs?.onSnapshot) {
          try {
            testKnobs.onSnapshot("exit", new Set(trackedDescendants));
          } catch (err: unknown) {
            try {
              observerError = safeError(err);
            } catch {
              observerError = new Error("<unprintable thrown value>");
            }
          }
        }
      }

      try {
        await teardownProcessTreeInner({
          childPid,
          childPgid,
          trackedDescendants,
          accumulatedDescendants,
          permit,
        }, undefined, {
          signalFn: testKnobs?.signalFn,
          timeoutMs: testKnobs?.teardownTimeoutMs,
        });
      } catch (tdErr: any) {
        if (tdErr instanceof AdapterFailure && tdErr.code === "KILLSET_REFUSED") {
          const note = poisonNote(permit, "held-by-killset-refusal");
          if (note) {
            tdErr.poisonNotRecorded = note.replace(/^;\s*poison not recorded:\s*/, "");
            if (!tdErr.message.includes(note)) tdErr.message += note;
          }
        }
        if (observerError && tdErr && typeof tdErr === "object") {
          tdErr.observerError = observerError;
        }
        if (pollerError && tdErr && typeof tdErr === "object") {
          tdErr.pollerError = pollerError;
        }
        throw tdErr;
      }

      // R4b: every descendant seen in any ancestry snapshot, or in the final snapshot taken at child exit, is guarded and signalled before the permit is released. NOT contained: (a) a descendant that leaves ancestry/session (fork+setsid+exit) inside one sampling gap; (b) any process the child has launchd start (open/launchctl/XPC). This is a known limit for a non-root runner on macOS. The permit caps concurrent Claude CLI turns, not every process those turns cause.
      // BELIEVE, not measured: an escaped descendant that is itself a claude CLI process would use a Max seat outside the permit.
      // If the child was never observed in an ancestry snapshot, or snapshot gap exceeded bound,
      // fail closed: poison permit with held-by-unconfirmed-teardown and throw TEARDOWN_UNCONFIRMED.
      const gapAtExit = (firstDeadSampleTime > 0 && lastSnapshotWithChild > 0) ? (firstDeadSampleTime - lastSnapshotWithChild) : 0;
      const treeProven = !pollerError && childObservedInSnapshot && (childObservedCount >= 2) && (maxObservedGapMs <= maxGap) && (gapAtExit <= maxGap);
      if (!treeProven) {
        const note = poisonNote(permit, "held-by-unconfirmed-teardown");
        const failureReason = pollerError
          ? `ancestry poller error: ${safeErrorText(pollerError)}`
          : (!childObservedInSnapshot || childObservedCount < 2
              ? "child exited before ancestry snapshot observed descendants"
              : `snapshot gap ${Math.max(maxObservedGapMs, gapAtExit)}ms exceeded bound ${maxGap}ms`);
        const err = new AdapterFailure(
          "TEARDOWN_UNCONFIRMED",
          `unconfirmed child ancestry containment: ${failureReason}; permit withheld${note}`,
          null,
          false,
        );
        if (note) err.poisonNotRecorded = note.replace(/^;\s*poison not recorded:\s*/, "");
        if (observerError) err.observerError = observerError;
        if (pollerError) err.pollerError = pollerError;
        throw err;
      }
    }
    permit.release();
  }

  if (spawnError) {
    if (spawnError instanceof AdapterFailure && spawnError.code === "KILLSET_REFUSED") {
      const note = poisonNote(permit, "held-by-killset-refusal");
      if (note) {
        spawnError.poisonNotRecorded = note.replace(/^;\s*poison not recorded:\s*/, "");
        if (!spawnError.message.includes(note)) spawnError.message += note;
      }
    }
    if (spawnError && typeof spawnError === "object") {
      if (observerError && !spawnError.observerError) {
        spawnError.observerError = observerError;
      }
      if (pollerError && !spawnError.pollerError) {
        spawnError.pollerError = pollerError;
      }
    }
    throw spawnError;
  }

  return {
    ...resToReturn!,
    ...(observerError !== undefined ? { observerError } : {}),
    ...(pollerError !== null ? { pollerError } : {}),
  };
}

/**
 * R5 (rework 7 + rework 8): config gate inspecting all effective configuration sources
 * (user, profile, project, local, managed) and provider/helper/env_key redirects.
 * Any parser failure or unverified/absent config blocks with CONFIG_UNVERIFIED before spawn.
 */
export function assertConfigGate(childEnv: Readonly<Record<string, string>>, cwd?: string): void {
  const inspectJsonConfig = (cfgPath: string) => {
    if (!existsSync(cfgPath)) return;
    const refused = configEnvRefusedNames(cfgPath);
    if (!Array.isArray(refused)) {
      throw new AdapterFailure("CONFIG_UNVERIFIED", refused.reason, null, false);
    }
    if (refused.length > 0) {
      throw new AdapterFailure("CONFIG_UNVERIFIED", `config carries refused names: ${refused.join(",")}`, null, false);
    }
    let raw: any;
    try {
      raw = JSON.parse(readFileSync(cfgPath, "utf8"));
    } catch (e: any) {
      throw new AdapterFailure("CONFIG_UNVERIFIED", `config parser failure in ${cfgPath}: ${e.message}`, null, false);
    }
    if (raw && typeof raw === "object") {
      const redirects = [
        "apiKeyHelper",
        "api_key_helper",
        "apiKeyCommand",
        "api_key_command",
        "model_provider",
        "provider",
        "baseUrl",
        "base_url",
        "endpoint",
        "env_key",
      ];
      for (const r of redirects) {
        if (r in raw && raw[r]) {
          throw new AdapterFailure("CONFIG_UNVERIFIED", `provider/helper redirect in config: ${r}`, null, false);
        }
      }
      if (raw.env && typeof raw.env === "object") {
        for (const [k, v] of Object.entries(raw.env)) {
          if (v) {
            if (k.endsWith("_BASE_URL") || k === "ANTHROPIC_BASE_URL" || redirects.includes(k) || (L10_REFUSED_SINGLES as readonly string[]).includes(k)) {
              throw new AdapterFailure("CONFIG_UNVERIFIED", `provider/helper redirect or refused name in config env: ${k}`, null, false);
            }
          }
        }
      }
    }
  };

  const inspectTomlConfig = (tomlPath: string) => {
    if (!existsSync(tomlPath)) return;
    let content = "";
    try {
      content = readFileSync(tomlPath, "utf8");
    } catch {}
    for (const name of L10_REFUSED_SINGLES) {
      if (content.includes(name)) {
        throw new AdapterFailure("CONFIG_UNVERIFIED", `config carries refused names: ${name}`, null, false);
      }
    }
    const pythonScript = `
import sys
try:
    import tomllib
except ImportError:
    try:
        import tomli as tomllib
    except ImportError:
        print("PARSE_ERROR: tomllib unavailable")
        sys.exit(1)
try:
    with open(sys.argv[1], "rb") as f:
        data = tomllib.load(f)
except Exception as e:
    print(f"PARSE_ERROR: {e}")
    sys.exit(1)
redirect_keys = {"model_provider", "provider", "base_url", "baseUrl", "apiKeyHelper", "api_key_helper", "api_key_command", "apiKeyCommand", "env_key", "endpoint"}
def check_dict(d):
    for k, v in d.items():
        if k in redirect_keys and v:
            print(f"REDIRECT_KEY: {k}")
            sys.exit(2)
        if isinstance(v, dict):
            check_dict(v)
check_dict(data)
print("OK")
sys.exit(0)
`;
    const pyBin = existsSync("/usr/local/bin/python") ? "/usr/local/bin/python" : (existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3");
    try {
      const res = execFileSync(pyBin, ["-c", pythonScript, tomlPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (!res.startsWith("OK")) {
        throw new AdapterFailure("CONFIG_UNVERIFIED", `invalid TOML config in ${tomlPath}: ${res}`, null, false);
      }
    } catch (e: any) {
      if (e instanceof AdapterFailure) throw e;
      const stderr = e.stdout ? e.stdout.toString().trim() : (e.message || "");
      throw new AdapterFailure("CONFIG_UNVERIFIED", `TOML validation failure in ${tomlPath}: ${stderr}`, null, false);
    }
  };

  // 1. Claude configuration sources
  if (childEnv.CLAUDE_CONFIG_DIR) {
    const cDir = childEnv.CLAUDE_CONFIG_DIR;
    if (!existsSync(cDir)) {
      throw new AdapterFailure("CONFIG_UNVERIFIED", `missing config directory: ${cDir}`, null, false);
    }
    let entries: string[];
    try {
      entries = readdirSync(cDir);
    } catch (e: any) {
      throw new AdapterFailure("CONFIG_UNVERIFIED", `unreadable config directory in CLAUDE_CONFIG_DIR: ${cDir}: ${e.message}`, null, false);
    }
    for (const f of entries) {
      if (f.endsWith(".toml") || f.endsWith(".yaml") || f.endsWith(".yml")) {
        throw new AdapterFailure("CONFIG_UNVERIFIED", `unsupported config format in ${cDir}: ${f}`, null, false);
      }
    }
    const claudeConfigs = ["settings.json", "settings.local.json", "config.json"];
    let foundAny = false;
    for (const f of claudeConfigs) {
      const p = join(cDir, f);
      if (existsSync(p)) {
        foundAny = true;
        inspectJsonConfig(p);
      }
    }
    if (!foundAny) {
      throw new AdapterFailure("CONFIG_UNVERIFIED", `absent config: no configuration file found in ${cDir}`, null, false);
    }
  }

  // 2. Project/local and ancestor directory configuration sources
  if (cwd && existsSync(cwd)) {
    let curr = resolve(cwd);
    const checkedDirs = new Set<string>();
    while (curr && !checkedDirs.has(curr)) {
      checkedDirs.add(curr);

      // Check curr/.claude
      const projectClaude = join(curr, ".claude");
      if (existsSync(projectClaude)) {
        let entries: string[];
        try {
          entries = readdirSync(projectClaude);
        } catch (e: any) {
          throw new AdapterFailure("CONFIG_UNVERIFIED", `unreadable config directory: ${projectClaude}: ${e.message}`, null, false);
        }
        for (const f of entries) {
          if (f.endsWith(".toml") || f.endsWith(".yaml") || f.endsWith(".yml")) {
            throw new AdapterFailure("CONFIG_UNVERIFIED", `unsupported config format in ${projectClaude}: ${f}`, null, false);
          }
        }
        for (const f of ["settings.json", "settings.local.json", "config.json"]) {
          const p = join(projectClaude, f);
          if (existsSync(p)) inspectJsonConfig(p);
        }
      }

      // Check curr/.codex
      const projectCodex = join(curr, ".codex");
      if (existsSync(projectCodex)) {
        let entries: string[];
        try {
          entries = readdirSync(projectCodex);
        } catch (e: any) {
          throw new AdapterFailure("CONFIG_UNVERIFIED", `unreadable config directory: ${projectCodex}: ${e.message}`, null, false);
        }
        for (const f of entries) {
          if (f.endsWith(".yaml") || f.endsWith(".yml")) {
            throw new AdapterFailure("CONFIG_UNVERIFIED", `unsupported config format in ${projectCodex}: ${f}`, null, false);
          }
        }
        inspectTomlConfig(join(projectCodex, "config.toml"));
        for (const f of ["settings.json", "config.json"]) {
          inspectJsonConfig(join(projectCodex, f));
        }
      }

      // Check curr itself for settings files
      for (const f of ["settings.json", "settings.local.json", "config.json"]) {
        const p = join(curr, f);
        if (existsSync(p)) inspectJsonConfig(p);
      }
      const currToml = join(curr, "config.toml");
      if (existsSync(currToml)) {
        inspectTomlConfig(currToml);
      }

      const parent = dirname(curr);
      if (parent === curr) break; // reached filesystem root
      curr = parent;
    }
  }

  // 3. User HOME configuration sources (when distinct)
  if (childEnv.HOME && existsSync(childEnv.HOME)) {
    const homeClaude = join(childEnv.HOME, ".claude");
    if (existsSync(homeClaude) && homeClaude !== childEnv.CLAUDE_CONFIG_DIR) {
      let entries: string[];
      try {
        entries = readdirSync(homeClaude);
      } catch (e: any) {
        throw new AdapterFailure("CONFIG_UNVERIFIED", `unreadable config directory: ${homeClaude}: ${e.message}`, null, false);
      }
      for (const f of entries) {
        if (f.endsWith(".toml") || f.endsWith(".yaml") || f.endsWith(".yml")) {
          throw new AdapterFailure("CONFIG_UNVERIFIED", `unsupported config format in ${homeClaude}: ${f}`, null, false);
        }
      }
      for (const f of ["settings.json", "settings.local.json", "config.json"]) {
        const p = join(homeClaude, f);
        if (existsSync(p)) inspectJsonConfig(p);
      }
    }
    const homeCodex = join(childEnv.HOME, ".codex");
    if (existsSync(homeCodex) && homeCodex !== childEnv.CODEX_HOME) {
      let entries: string[];
      try {
        entries = readdirSync(homeCodex);
      } catch (e: any) {
        throw new AdapterFailure("CONFIG_UNVERIFIED", `unreadable config directory: ${homeCodex}: ${e.message}`, null, false);
      }
      for (const f of entries) {
        if (f.endsWith(".yaml") || f.endsWith(".yml")) {
          throw new AdapterFailure("CONFIG_UNVERIFIED", `unsupported config format in ${homeCodex}: ${f}`, null, false);
        }
      }
      inspectTomlConfig(join(homeCodex, "config.toml"));
      for (const f of ["settings.json", "config.json"]) {
        const p = join(homeCodex, f);
        if (existsSync(p)) inspectJsonConfig(p);
      }
    }
  }

  // 4. Managed configuration sources (system / enterprise paths)
  for (const mDir of ["/Library/Application Support/ClaudeCode", "/etc/claude", "/etc/claude-code"]) {
    if (existsSync(mDir)) {
      let entries: string[];
      try {
        entries = readdirSync(mDir);
      } catch (e: any) {
        throw new AdapterFailure("CONFIG_UNVERIFIED", `unreadable config directory: ${mDir}: ${e.message}`, null, false);
      }
      for (const f of entries) {
        if (f.endsWith(".toml") || f.endsWith(".yaml") || f.endsWith(".yml")) {
          throw new AdapterFailure("CONFIG_UNVERIFIED", `unsupported config format in ${mDir}: ${f}`, null, false);
        }
      }
      for (const f of ["settings.json", "settings.local.json", "config.json", "managed-settings.json"]) {
        const p = join(mDir, f);
        if (existsSync(p)) inspectJsonConfig(p);
      }
    }
  }
  for (const mDir of ["/etc/codex"]) {
    if (existsSync(mDir)) {
      const tomlP = join(mDir, "config.toml");
      if (existsSync(tomlP)) inspectTomlConfig(tomlP);
    }
  }

  // 5. Codex configuration sources
  if (childEnv.CODEX_HOME) {
    const cDir = childEnv.CODEX_HOME;
    if (!existsSync(cDir)) {
      throw new AdapterFailure("CONFIG_UNVERIFIED", `missing config directory: ${cDir}`, null, false);
    }
    const tomlPath = join(cDir, "config.toml");
    if (!existsSync(tomlPath)) {
      throw new AdapterFailure("CONFIG_UNVERIFIED", `absent config: missing required config.toml in ${cDir}`, null, false);
    }
    let entries: string[];
    try {
      entries = readdirSync(cDir);
    } catch (e: any) {
      throw new AdapterFailure("CONFIG_UNVERIFIED", `unreadable config directory in CODEX_HOME: ${cDir}: ${e.message}`, null, false);
    }
    for (const f of entries) {
      if (f.endsWith(".yaml") || f.endsWith(".yml")) {
        throw new AdapterFailure("CONFIG_UNVERIFIED", `unsupported config format in ${cDir}: ${f}`, null, false);
      }
    }
    inspectTomlConfig(tomlPath);
    for (const f of ["settings.json", "config.json"]) {
      const p = join(cDir, f);
      if (existsSync(p)) inspectJsonConfig(p);
    }
  }
}

export interface SpawnL10ChildInnerOptions {
  argv: string[];
  cwd: string;
  childEnv: Readonly<Record<string, string>>;
  promptText: string;
  timeoutMs: number;
  cancelSignal: { cancelled: () => boolean };
  permit?: { poison: (reason: string) => any; release?: () => void };
}

export interface SpawnL10ChildInnerTestOptions extends SpawnL10ChildInnerOptions {
  signalFn?: SignalFn;
}

export async function spawnL10ChildInnerForTest(
  opts: SpawnL10ChildInnerTestOptions,
  onSpawn?: (pid: number) => void,
  trackedDescendants?: Set<number>,
  accumulatedDescendants?: Map<number, { lstart?: string; cmd?: string }>,
  internal?: { signalFn?: SignalFn },
): Promise<{ stdoutText: string; stderrText: string; diagnostic: L10Diagnostic; childPid: number }> {
  const { signalFn, ...prodOpts } = opts;
  return spawnL10ChildInner(
    prodOpts,
    onSpawn,
    trackedDescendants,
    accumulatedDescendants,
    { signalFn: signalFn ?? internal?.signalFn },
  );
}

async function spawnL10ChildInner(
  opts: SpawnL10ChildInnerOptions,
  onSpawn?: (pid: number) => void,
  trackedDescendants?: Set<number>,
  accumulatedDescendants?: Map<number, { lstart?: string; cmd?: string }>,
  internal?: { signalFn?: SignalFn },
): Promise<{ stdoutText: string; stderrText: string; diagnostic: L10Diagnostic; childPid: number }> {
  const accDesc = accumulatedDescendants ?? new Map<number, { lstart?: string; cmd?: string }>();
  // R4 (rework 5): cancellation checked before spawn
  if (opts.cancelSignal.cancelled()) {
    throw new AdapterFailure("TRANSPORT_ERROR", "cancelled before spawn", null, false);
  }
  // D2 (rework 2) + R1 (rework 3): spawn-time tripwire on BOTH surfaces —
  // the console (parent) env must still be §c clean, and the constructed
  // child env must carry no refused name either (v3 §c L73; the same
  // predicate gates parent and child). Exits the turn on violation; no
  // child is spawned.
  assertSpawnTripwire(process.env, "parent");
  assertSpawnTripwire({ ...(opts.childEnv as Record<string, string>) }, "child");

  // R5 (rework 6 + rework 7): pre-spawn model and config gates in the real production spawn path
  let hasModel = false;
  for (let i = 0; i < opts.argv.length; i++) {
    if (opts.argv[i] === "--model") {
      hasModel = true;
      if (i + 1 < opts.argv.length) {
        assertValidModelLiteral(opts.argv[i + 1]);
      } else {
        throw new AdapterFailure("MODEL_UNAVAILABLE", "empty model literal", null, false);
      }
    }
  }

  const isCliInvocation = opts.argv[0]?.endsWith("/claude") || opts.argv[0] === "claude"
    || opts.argv[0]?.endsWith("/codex") || opts.argv[0] === "codex"
    || opts.argv.includes("--print") || opts.argv.includes("--restricted")
    || (opts.argv.includes("exec") && opts.argv.includes("--json"));
  if (isCliInvocation && !hasModel) {
    throw new AdapterFailure("MODEL_UNAVAILABLE", "missing model literal", null, false);
  }
  assertConfigGate(opts.childEnv, opts.cwd);

  return new Promise((resolve, reject) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let settled = false;
    let childClosed = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutHasher = createHash("sha256");
    const stderrHasher = createHash("sha256");

    const child = spawn(opts.argv[0], opts.argv.slice(1), {
      cwd: opts.cwd,
      env: { ...opts.childEnv },
      stdio: ["pipe", "pipe", "pipe"],
      // B6 (rework 1 C6): spawn the child in its own process group so
      // timeout/cancel can kill the wrapper AND the wrapper's descendants
      detached: true,
    });
    if (child.pid) {
      recordProcessIdentity(child.pid, accDesc);
      if (onSpawn) {
        onSpawn(child.pid);
      }
    }

    const isAlive = (target: number): boolean => {
      if (internal?.signalFn) {
        const res = internal.signalFn(target, 0);
        return res === true;
      }
      try {
        process.kill(target, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };

    const doKill = internal?.signalFn ?? ((t: number, s: NodeJS.Signals | 0) => {
      try {
        process.kill(t, s);
        return true;
      } catch {
        return false;
      }
    });

    const sweepDescendants = () => {
      if (child.pid) {
        const found = findDescendants(child.pid);
        for (const d of found) {
          if (trackedDescendants) trackedDescendants.add(d);
        }
      }
    };

    const approvedTargets = new Set<number>();

    const killProcessGroup = () => {
      sweepDescendants();
      const planned = new Set<number>();
      if (child.pid) planned.add(child.pid);
      if (trackedDescendants) {
        for (const d of Array.from(trackedDescendants)) planned.add(d);
      }
      if (child.pid && isSafeToKillGroup(child.pid, child.pid)) {
        const groupMembers = findPidsByPgid(child.pid);
        if (groupMembers === null) {
          const note = poisonNote(opts.permit, "held-by-killset-refusal");
          const err = new AdapterFailure(
            "KILLSET_REFUSED",
            `kill-set refused: unable to read process group members for pgid ${child.pid}${note}`,
            null,
            false,
          );
          if (note) err.poisonNotRecorded = note.replace(/^;\s*poison not recorded:\s*/, "");
          throw err;
        }
        for (const d of groupMembers) planned.add(d);
      }
      assertSafeKillSet(Array.from(planned));
      approvedTargets.clear();
      for (const p of Array.from(planned)) approvedTargets.add(p);

      for (const d of Array.from(approvedTargets)) {
        if (d === child.pid) continue;
        try { doKill(d, "SIGKILL"); } catch {}
      }
      if (child.pid) {
        try { doKill(child.pid, "SIGKILL"); } catch {}
        if (checkGroupSignalSafety(child.pid, child.pid, accDesc, approvedTargets, opts.permit)) {
          try { doKill(-child.pid, "SIGKILL"); } catch { /* group already gone */ }
        }
      }
    };

    /** R4 (rework 5 + rework 7b): confirm child and descendants are dead */
    const waitGroupDead = (
      pgid: number,
      done: () => void,
      onError: (err: AdapterFailure) => void,
      attempts = 3,
    ) => {
      try {
        assertSafeKillSet(Array.from(approvedTargets));
      } catch (err: any) {
        const failure = err instanceof AdapterFailure && err.code === "KILLSET_REFUSED"
          ? err
          : new AdapterFailure("KILLSET_REFUSED", err?.message ?? "killset refused on waitGroupDead", null, false);
        onError(failure);
        return;
      }
      const probe = (left: number) => {
        try {
          let dead = child.pid ? !isAlive(child.pid) : true;
          if (child.pid && isSafeToKillGroup(pgid, child.pid)) {
            if (isAlive(-pgid)) dead = false;
          }
          let descendantsDead = true;
          for (const d of Array.from(approvedTargets)) {
            if (d === child.pid) continue;
            if (isAlive(d)) {
              descendantsDead = false;
              const meta = accumulatedDescendants?.get(d);
              const verified = verifyProcessIdentity(d, meta);
              if (verified) {
                try { doKill(d, "SIGKILL"); } catch {}
              }
            }
          }
          if ((dead && descendantsDead) || left <= 1) { done(); return; }
          setTimeout(() => probe(left - 1), 250);
        } catch (probeErr: any) {
          const failure = probeErr instanceof AdapterFailure && probeErr.code === "KILLSET_REFUSED"
            ? probeErr
            : new AdapterFailure("KILLSET_REFUSED", probeErr?.message ?? "killset refused in probe", null, false);
          onError(failure);
        }
      };
      probe(attempts);
    };

    const finish = (err: AdapterFailure | null, stdoutText?: string, diag?: L10Diagnostic, stderrText?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      const settleNow = (finalErr: AdapterFailure | null) => {
        if (finalErr) {
          if (finalErr.code === "KILLSET_REFUSED") {
            const note = poisonNote(opts.permit, "held-by-killset-refusal");
            if (note) {
              finalErr.poisonNotRecorded = note.replace(/^;\s*poison not recorded:\s*/, "");
              if (!finalErr.message.includes(note)) finalErr.message += note;
            }
          }
          reject(finalErr);
        } else {
          resolve({ stdoutText: stdoutText!, stderrText: stderrText ?? "", diagnostic: diag!, childPid: child.pid! });
        }
      };
      if (err && !childClosed) {
        if (err.code === "KILLSET_REFUSED") {
          settleNow(err);
          return;
        }
        try {
          killProcessGroup();
          waitGroupDead(
            child.pid!,
            () => settleNow(err),
            (wgErr) => settleNow(wgErr),
          );
        } catch (kgErr: any) {
          const effectiveErr = (kgErr instanceof AdapterFailure && kgErr.code === "KILLSET_REFUSED")
            ? kgErr
            : (err ?? kgErr);
          settleNow(effectiveErr);
          return;
        }
      } else {
        settleNow(err);
      }
    };

    /** R9 (rework 3 + rework 5): incrementally hash ALL observed stream
     *  bytes across all chunks so overflow diagnostics reflect total
     *  observed byte count and exact stream SHA-256 while keeping buffered
     *  chunks bounded. Never emits stream bodies. */
    const currentDiag = (exitCode: number | null): L10Diagnostic => ({
      exitCode: exitCode ?? -1,
      stdoutBytes,
      stdoutSha256: stdoutHasher.copy().digest("hex"),
      stderrBytes,
      stderrSha256: stderrHasher.copy().digest("hex"),
    });
    const failWithDiag = (code: string, message: string, retryable: boolean) =>
      new AdapterFailure(code, message, null, retryable, currentDiag(null));

    const timer = setTimeout(() => {
      try {
        killProcessGroup();
      } catch (kgErr: any) {
        finish(kgErr instanceof AdapterFailure ? kgErr : new AdapterFailure("KILLSET_REFUSED", kgErr?.message ?? "killset refused on timeout", null, false));
        return;
      }
      try {
        finish(failWithDiag("TIMEOUT", "turn time budget reached", true));
      } catch (err: any) {
        finish(err instanceof AdapterFailure && err.code === "KILLSET_REFUSED" ? err : new AdapterFailure("KILLSET_REFUSED", err?.message ?? "killset refused on timeout", null, false));
      }
    }, opts.timeoutMs);
    const poll = setInterval(() => {
      sweepDescendants();
      if (opts.cancelSignal.cancelled()) {
        try {
          killProcessGroup();
        } catch (kgErr: any) {
          finish(kgErr instanceof AdapterFailure ? kgErr : new AdapterFailure("KILLSET_REFUSED", kgErr?.message ?? "killset refused on cancel", null, false));
          return;
        }
        try {
          finish(failWithDiag("TRANSPORT_ERROR", "cancelled", false));
        } catch (err: any) {
          finish(err instanceof AdapterFailure && err.code === "KILLSET_REFUSED" ? err : new AdapterFailure("KILLSET_REFUSED", err?.message ?? "killset refused on cancel", null, false));
        }
      }
    }, 200);

    child.stdout!.on("data", (d: Buffer | string) => {
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
      stdoutHasher.update(buf);
      stdoutBytes += buf.length;
      if (stdoutBytes <= L10_MAX_OUTPUT_BYTES) {
        stdoutChunks.push(buf);
      } else {
        stdoutOverflow = true;
        if (stdoutBytes >= 2_000_000) {
          try {
            killProcessGroup();
          } catch (kgErr: any) {
            finish(kgErr instanceof AdapterFailure ? kgErr : new AdapterFailure("KILLSET_REFUSED", kgErr?.message ?? "killset refused on stdout overflow", null, false));
            return;
          }
        }
      }
    });
    child.stderr!.on("data", (d: Buffer | string) => {
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
      stderrHasher.update(buf);
      stderrBytes += buf.length;
      if (stderrBytes <= L10_MAX_OUTPUT_BYTES) {
        stderrChunks.push(buf);
      } else {
        stderrOverflow = true;
        if (stderrBytes >= 2_000_000) {
          try {
            killProcessGroup();
          } catch (kgErr: any) {
            finish(kgErr instanceof AdapterFailure ? kgErr : new AdapterFailure("KILLSET_REFUSED", kgErr?.message ?? "killset refused on stderr overflow", null, false));
            return;
          }
        }
      }
    });
    child.on("error", (e: Error) => {
      finish(new AdapterFailure("TRANSPORT_ERROR", `spawn error: ${e.message}`, null, true));
    });
    child.on("close", (code) => {
      childClosed = true;
      if (settled) return;
      const diag: L10Diagnostic = {
        exitCode: code ?? -1,
        stdoutBytes,
        stdoutSha256: stdoutHasher.copy().digest("hex"),
        stderrBytes,
        stderrSha256: stderrHasher.copy().digest("hex"),
      };
      if (stdoutOverflow) {
        finish(new AdapterFailure("STDOUT_OVERFLOW", "stdout exceeded 64,000 B cap", null, false, diag));
        return;
      }
      if (stderrOverflow) {
        finish(new AdapterFailure("STDERR_OVERFLOW", "stderr exceeded 64,000 B cap", null, false, diag));
        return;
      }
      const stdoutBuf = Buffer.concat(stdoutChunks);
      const stderrBuf = Buffer.concat(stderrChunks);
      finish(null, stdoutBuf.toString("utf8"), diag, stderrBuf.toString("utf8"));
    });

    // Write the prompt to STDIN and close the write end.
    child.stdin!.on("error", () => { /* already-closed stdins are fine */ });
    child.stdin!.end(opts.promptText);
  });
}

/**
 * Two-permit lock for the Claude route. v3 §g.4: at most 2 Claude children
 * may be active across the local console and the pole harness, enforced
 * by one shared permit pool under /tmp/l10/permits. The lock is a small
 * JSON file written atomically; the caller holds the permit and is
 * responsible for releasing it on every exit (success, error, timeout,
 * cancellation).
 */
type Permit = { pid: number; runId: string; acquiredAt: number };

export class L10PermitPool {
  private readonly dir: string;
  private readonly max: number;
  constructor(dir: string = L10_CLAUDE_PERMIT_DIR, max: number = L10_CLAUDE_MAX_CONCURRENT) {
    this.dir = dir;
    this.max = max;
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
  }

  public get poolDir(): string {
    return this.dir;
  }

  /**
   * R4 (rework 5 + rework 6) + the security reviewer Y1: serialized pool lock.
   * Atomic lock creation WITH its JSON content via linkSync from a temporary
   * file in this.dir (never create-then-fill with openSync/wx).
   * Contenders reclaim ONLY on proven owner death (process.kill(info.pid, 0) ESRCH).
   * Unparseable or live locks are NEVER unlinked. Age fallback is deleted (Y1).
   * Sleep uses in-process Atomics.wait to eliminate busy spinning.
   * Final unlink in finally only if we own it (pid match).
   */
  private withLock<T>(fn: () => T, timeoutMs = 5000): T {
    const lockPath = join(this.dir, ".pool.lock");
    const reclaimLock = join(this.dir, ".pool.lock.reclaim");
    const start = Date.now();
    let acquired = false;

    while (!acquired) {
      const tmpPath = join(this.dir, `.pool.lock.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`);
      const tmpBackup = `${tmpPath}.bak`;
      try {
        writeFileSync(tmpPath, JSON.stringify({ pid: process.pid, lockedAt: Date.now() }), "utf8");
        linkSync(tmpPath, tmpBackup);
        linkSync(tmpPath, lockPath);
        acquired = true;
      } catch {
        // Destination lock exists or contention. Inspect lock holder.
        try {
          const stat1 = statSync(lockPath);
          const content1 = readFileSync(lockPath, "utf8");
          const info = JSON.parse(content1);
          let dead = false;
          if (typeof info?.pid === "number" && info.pid > 0) {
            try {
              process.kill(info.pid, 0);
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === "ESRCH") dead = true;
            }
          }
          if (dead) {
            // Proven dead owner (ESRCH) — serialize reclaim against replacement
            // Contenders race atomically to claim the reclaim right via linkSync on .pool.lock.reclaim
            let wonReclaimRight = false;
            try {
              linkSync(tmpPath, reclaimLock);
              wonReclaimRight = true;
            } catch {
              // R4a: Stale reclaim token check — clean up ONLY if verified dead AND unreplaced
              try {
                const recStat1 = statSync(reclaimLock);
                const recContent = readFileSync(reclaimLock, "utf8");
                const recInfo = JSON.parse(recContent);
                if (typeof recInfo?.pid === "number" && recInfo.pid > 0) {
                  try { process.kill(recInfo.pid, 0); }
                  catch (e) {
                    if ((e as NodeJS.ErrnoException).code === "ESRCH") {
                      // Atomic verification before unlinking: re-stat reclaimLock to ensure
                      // it has not been replaced by another live contender in the interim.
                      try {
                        const recStat2 = statSync(reclaimLock);
                        const recContent2 = readFileSync(reclaimLock, "utf8");
                        if (recStat2.ino === recStat1.ino && recContent2 === recContent) {
                          unlinkSync(reclaimLock);
                        }
                      } catch {}
                    }
                  }
                }
              } catch {}
            }

            if (wonReclaimRight) {
              try {
                // R4a: Verify reclaimLock is STILL the token we created and linked (inode check)
                let tokenIntact = false;
                try {
                  const recStat = statSync(reclaimLock);
                  if (recStat.ino === statSync(tmpBackup).ino) {
                    tokenIntact = true;
                  }
                } catch {}

                if (tokenIntact) {
                  // Re-observe lockPath: must still be the EXACT observed inode & content
                  let stillDeadOwner = false;
                  try {
                    const stat2 = statSync(lockPath);
                    const content2 = readFileSync(lockPath, "utf8");
                    if (stat2.ino === stat1.ino && content2 === content1) {
                      stillDeadOwner = true;
                    }
                  } catch {}

                  if (stillDeadOwner) {
                    // Atomic replace: renameSync atomically replaces lockPath with our verified reclaimLock
                    renameSync(reclaimLock, lockPath);
                    // Confirm we own the published lock
                    try {
                      const finalStat = statSync(lockPath);
                      if (finalStat.ino === statSync(tmpBackup).ino) {
                        acquired = true;
                      }
                    } catch {}
                  }
                }
              } finally {
                if (!acquired) {
                  try {
                    if (statSync(reclaimLock).ino === statSync(tmpBackup).ino) {
                      unlinkSync(reclaimLock);
                    }
                  } catch {}
                }
              }
            }
          }
        } catch {
          // Never unlink unparseable or live locks
        }
        if (Date.now() - start > timeoutMs) {
          throw new AdapterFailure("TIMEOUT", "permit pool lock timeout", null, true);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      } finally {
        try { unlinkSync(tmpPath); } catch {}
        try { unlinkSync(tmpBackup); } catch {}
      }
    }

    try {
      return fn();
    } finally {
      try {
        const content = readFileSync(lockPath, "utf8");
        const info = JSON.parse(content);
        if (info?.pid === process.pid) {
          unlinkSync(lockPath);
        }
      } catch {}
    }
  }

  /** Acquire a permit, blocking until one is free or the deadline/cancel
   *  fires. R4 (rework 5): cancellation/deadline checked BEFORE immediate
   *  acquisition and before each retry. */
  async acquire(runId: string, opts: { deadlineMs?: number; cancelSignal?: { cancelled: () => boolean } } = {}): Promise<{ slot: number; release: () => void; poison: (reason: string) => { recorded: boolean; reason?: string } }> {
    const deadline = opts.deadlineMs !== undefined ? Date.now() + opts.deadlineMs : null;

    if (opts.cancelSignal?.cancelled()) {
      throw new AdapterFailure("TRANSPORT_ERROR", "permit acquire cancelled", null, false);
    }
    if (deadline !== null && Date.now() >= deadline) {
      throw new AdapterFailure("TIMEOUT", "permit acquire deadline reached", null, true);
    }

    const tryOnce = (): { slot: number; release: () => void; poison: (reason: string) => { recorded: boolean; reason?: string } } | null => {
      if (opts.cancelSignal?.cancelled()) return null;
      if (deadline !== null && Date.now() >= deadline) return null;
      return this.withLock(() => {
        for (let slot = 0; slot < this.max; slot++) {
          const path = join(this.dir, `permit-${slot}.json`);
          if (this.tryClaim(path, runId)) {
            return {
              slot,
              release: () => this.release(path, runId),
              poison: (reason: string) => this.poison(path, runId, reason),
            };
          }
        }
        return null;
      });
    };

    const immediate = tryOnce();
    if (immediate) return immediate;

    return new Promise((resolve, reject) => {
      const retry = () => {
        if (opts.cancelSignal?.cancelled()) {
          reject(new AdapterFailure("TRANSPORT_ERROR", "permit acquire cancelled", null, false));
          return;
        }
        if (deadline !== null && Date.now() >= deadline) {
          reject(new AdapterFailure("TIMEOUT", "permit acquire deadline reached", null, true));
          return;
        }
        const got = tryOnce();
        if (got) { resolve(got); return; }
        setTimeout(retry, 50);
      };
      retry();
    });
  }

  /**
   * R4 (rework 5): ownership-safe claim and reclaim. Under the pool lock:
   * (a) clean slot is claimed with openSync(wx).
   * (b) existing slot held by PROVEN-DEAD process is safely reclaimed only after
   *     verifying the dead PID has not been replaced by a live process.
   * (c) if a live process is detected at any point, the claim is refused.
   */
  private tryClaim(path: string, runId: string): boolean {
    const now = Date.now();
    const permit: Permit = { pid: process.pid, runId, acquiredAt: now };

    if (!existsSync(path)) {
      try {
        const fd = openSync(path, "wx");
        try { writeFileSync(fd, JSON.stringify(permit), { encoding: "utf8" }); }
        finally { closeSync(fd); }
        return true;
      } catch {
        return false;
      }
    }

    // Slot file exists. Reclaim only on PROVEN death.
    let held: Permit;
    let text: string;
    try { text = readFileSync(path, "utf8"); held = JSON.parse(text) as Permit; }
    catch { return false; } // unparseable: fail closed
    if ((held as any)?.status === "POISONED") return false; // Poisoned permit cannot be reclaimed
    if (typeof held?.pid !== "number" || held.pid <= 0) return false;
    try { process.kill(held.pid, 0); return false; } // alive: no claim
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") return false; }

    // Re-verify immediately before reclaim
    let held2: Permit;
    try {
      const text2 = readFileSync(path, "utf8");
      if (text2 !== text) return false;
      held2 = JSON.parse(text2) as Permit;
    } catch { return false; }
    if ((held2 as any)?.status === "POISONED") return false;
    try { process.kill(held2.pid, 0); return false; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") return false; }

    // Write permit directly into path under the serialized pool lock
    try {
      writeFileSync(path, JSON.stringify(permit), { encoding: "utf8" });
      return true;
    } catch {
      return false;
    }
  }

  private poison(path: string, runId: string, reason: string): { recorded: boolean; reason?: string } {
    try {
      if (!existsSync(path)) {
        return { recorded: false, reason: "slot-absent" };
      }
      let lockFailedReason: string | undefined;
      this.withLock(() => {
        if (!existsSync(path)) {
          lockFailedReason = "slot-absent";
          return;
        }
        let held: Permit;
        try {
          held = JSON.parse(readFileSync(path, "utf8")) as Permit;
        } catch {
          lockFailedReason = "slot-unreadable";
          return;
        }
        if (held?.runId !== runId || held?.pid !== process.pid) {
          lockFailedReason = "slot-not-owned";
          return;
        }
        writeFileSync(path, JSON.stringify({ ...held, status: "POISONED", reason }), "utf8");
      }, 500);

      if (lockFailedReason) {
        return { recorded: false, reason: lockFailedReason };
      }
      return { recorded: true };
    } catch (lockErr: any) {
      // Option 1 (the supervisor): lock-free fallback if lock is busy/held or write failed.
      try {
        if (!existsSync(path)) {
          return { recorded: false, reason: "slot-absent" };
        }
        let held: Permit;
        try {
          held = JSON.parse(readFileSync(path, "utf8")) as Permit;
        } catch {
          return { recorded: false, reason: "slot-unreadable" };
        }
        if (held?.runId !== runId || held?.pid !== process.pid) {
          return { recorded: false, reason: "slot-not-owned" };
        }
        const dir = dirname(path);
        const tmpFile = join(dir, `.tmp-poison-${runId}-${Date.now()}`);
        writeFileSync(tmpFile, JSON.stringify({ ...held, status: "POISONED", reason }), "utf8");
        renameSync(tmpFile, path);
        return { recorded: true };
      } catch (fallbackErr: any) {
        const errno = fallbackErr?.code ?? fallbackErr?.errno ?? lockErr?.code ?? (typeof fallbackErr?.message === "string" && fallbackErr.message ? fallbackErr.message : "unknown");
        return { recorded: false, reason: `lock-timeout-and-fallback-write-failed: ${errno}` };
      }
    }
  }

  private release(path: string, runId: string): void {
    this.withLock(() => {
      try {
        if (!existsSync(path)) return;
        const held = JSON.parse(readFileSync(path, "utf8")) as Permit;
        if (held?.runId !== runId || held?.pid !== process.pid) return;
        if ((held as any)?.status === "POISONED") return;
        unlinkSync(path);
      } catch { /* already gone or not ours */ }
    });
  }
}

/** One shared pool for the local console and the pole harness (v3 §g.4:
 *  "enforced by one shared permit pool rather than a per-adapter
 *  counter"). Declared here (after the class) to avoid use-before-def. */
export const sharedClaudePermitPool = new L10PermitPool();

// writePromptTempFile was deleted in rework 1 C6: it contradicted R5
// (prompt on STDIN, never argv) and was unused. Prompts go through
// spawnL10Child's stdin pipe, never a temp file.

/**
 * Map the CLI's exit code to a static reason. v3 §g.4 R3: 75 (USAGE_WALL)
 * and 76 (AUTH_BLOCKED) are terminal AdapterFailures with distinct codes.
 * The skip list at cohort.ts:166 must cover them rather than revisiting
 * them. Missing binary/helper, unsupported argument, unavailable model,
 * missing model field, missing ledger, timeout, cancellation, generic
 * nonzero/transport error and guard refusal are INCONCLUSIVE or BLOCKED.
 */
export function classifyExit(exitCode: number): { code: string; staticReason: string; retryable: boolean } {
  if (exitCode === 0) return { code: "OK", staticReason: "zero exit", retryable: false };
  if (exitCode === L10_CLAUDE_USAGE_WALL_EXIT) {
    return { code: "USAGE_WALL", staticReason: "claude usage wall (exit 75); terminal", retryable: false };
  }
  if (exitCode === L10_CLAUDE_AUTH_BLOCKED_EXIT) {
    return { code: "AUTH_BLOCKED", staticReason: "claude auth blocked (exit 76); terminal", retryable: false };
  }
  if (exitCode === 137 /* SIGKILL */) {
    return { code: "TIMEOUT", staticReason: "killed (likely timeout)", retryable: true };
  }
  return { code: "TRANSPORT_ERROR", staticReason: `exit ${exitCode}`, retryable: true };
}
