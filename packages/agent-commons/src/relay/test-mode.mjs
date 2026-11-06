// Cloud Commons relay, L1: the --test-mode hooks (spec v3.4.5 13.2 "Test mode"; RT2 O12).
//
// server.mjs loads this module only when the relay starts with --test-mode, and only after the
// conjunctive start refusal has passed (the L1 test aud AND a loopback or named test-interface
// bind). A non-test build can leave this file out entirely (RT3: its entrypoint must not carry the
// flag).
//
// - Clock: relay time is the integer (ms) in <dir>/clock, read on every use. The harness moves it;
//   nothing in a request can set or move it.
// - Barriers: a closed list of named points in the request path. While <dir>/barriers/<name>.hold
//   exists, a request reaching that point writes <dir>/barriers/<name>.reached and waits until the
//   .hold file is gone. No request can name, create or clear a barrier.
// - Container-local only (O12 item 2): <dir> is one absolute, normalized path given at start, never
//   taken from a request, with no symlink anywhere in it (its realpath is itself). The directory and
//   every file read from it must be a real directory or regular file (never a symlink, so no path is
//   redirected elsewhere), owned by this process's user, and not writable by group or others. The
//   harness asserts no host mounts (13.2).

import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { RelayError } from "./records.mjs";

/**
 * The closed barrier list. Relay: before the L0 handler runs, and after it committed (before the
 * response). Reference client (13.2: "the reference client takes the same barrier hooks"): after it
 * read an inbox record and before handling it, after handling and before acknowledging, and before
 * it drains its outbox.
 */
export const BARRIERS = Object.freeze(["before-dispatch", "after-commit", "client-after-read", "client-after-handle", "client-before-drain"]);
const POLL_MS = 10;

function privateEntry(path, kind) {
  let st;
  try { st = lstatSync(path); } catch { return null; }
  const ok = (kind === "dir" ? st.isDirectory() : st.isFile()) && !st.isSymbolicLink()
    && (typeof process.getuid !== "function" || st.uid === process.getuid()) && (st.mode & 0o022) === 0;
  if (!ok) throw new RelayError("test-mode-path", 500, `${kind} must be a private ${kind === "dir" ? "directory" : "regular file"} of this user, not a symlink`);
  return st;
}

/**
 * Open the hooks for one test directory. Throws (and the relay refuses to start) unless the
 * directory and its clock file pass the checks above and the clock holds a valid time.
 * Returns { now(), barrier(name, signal), dir }.
 */
export function openTestHooks(dir) {
  if (typeof dir !== "string" || !isAbsolute(dir) || normalize(dir) !== dir || dir.length > 512) throw new RelayError("test-mode-path", 500, "test dir must be an absolute, normalized path");
  if (!privateEntry(dir, "dir")) throw new RelayError("test-mode-path", 500, "test dir missing");
  if (realpathSync(dir) !== dir) throw new RelayError("test-mode-path", 500, "test dir path must contain no symlink");
  const clockPath = join(dir, "clock");
  const barrierDir = join(dir, "barriers");

  function now() {
    if (!privateEntry(clockPath, "file")) throw new RelayError("test-clock", 500, "clock file missing");
    const text = readFileSync(clockPath, "utf8");
    if (!/^(0|[1-9][0-9]{0,15})\n?$/.test(text)) throw new RelayError("test-clock", 500, "clock file must hold one integer (ms)");
    const t = Number(text.trim());
    if (!Number.isSafeInteger(t)) throw new RelayError("test-clock", 500, "clock out of range");
    return t;
  }

  /** Wait at a named point while its .hold file exists. Resolves at once when there is none. */
  async function barrier(name, signal) {
    if (!BARRIERS.includes(name)) throw new RelayError("test-barrier", 500, "unknown barrier");
    const hold = join(barrierDir, `${name}.hold`);
    if (!privateEntry(barrierDir, "dir") || !privateEntry(hold, "file")) return;
    writeFileSync(join(barrierDir, `${name}.reached`), `${process.pid}\n`, { mode: 0o600 });
    while (!signal?.aborted && privateEntry(hold, "file")) await new Promise(r => setTimeout(r, POLL_MS));
  }

  now();   // refuse to start on a missing or invalid clock
  return Object.freeze({ now, barrier, dir });
}
