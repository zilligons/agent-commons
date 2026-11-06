// Cloud Commons relay, L2: the PRODUCTION entrypoint (-022 Addendum E P1; RT3). It is what
// `agent-commons relay serve` runs. It is a separate module from the L1 test entrypoint
// (server.mjs's command line) and it has no test flag: --test-mode, --test-dir and --test-interface are
// unknown arguments here, and the L1 test audience (or any non-https, non-canonical or `.test`
// audience) is refused. Every refusal exits with status 2 before anything listens, and the aud and
// bind are checked before any file is read.
//
//   agent-commons relay serve --aud https://<host>[:port] --bind <loopback ip> [--port <n>]
//     --db <dir>/relay*.db --roster <signed roster file> --policy <signed policy file>
//     --owner-public-key <64 hex> --relay-key-file <key seed file> [--access-log <file>]
//
// Files the owner custodies (formats only; this module mints no key):
//   --relay-key-file  one 64-hex Ed25519 key seed (RFC 8032), optionally newline-terminated;
//   --roster          the owner-signed roster  {body: {v: "commons-relay-roster/1", ...}, sig};
//   --policy          the owner-signed policy  {body: {v: "commons-relay-policy/1", ...}, sig}.
// Each must be a regular file (never a symlink) owned by this user with no group or other access
// (mode 0600 or stricter); anything else is refused. The access log, if named, must not exist yet or
// be such a file too. The process umask is 077, so relay.db, its WAL and the access log are private.
//
// The relay listens on plain HTTP on loopback only; the host's reverse proxy terminates TLS for the
// configured origin and sets X-Real-IP (server.mjs, production mode).

import { lstatSync, readFileSync, appendFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { StartRefused, checkStart, startRelay } from "./server.mjs";
import { openRelay } from "./roster.mjs";

/** The production flags. No test flag exists here (RT3). */
export const SERVE_FLAGS = Object.freeze(["--aud", "--bind", "--port", "--db", "--roster", "--policy", "--owner-public-key", "--relay-key-file", "--access-log"]);
const REQUIRED = Object.freeze(["aud", "bind", "db", "roster", "policy", "owner-public-key", "relay-key-file"]);

export function parseServeArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!SERVE_FLAGS.includes(flag)) throw new StartRefused([`unknown argument ${JSON.stringify(String(flag).slice(0, 40))}`]);
    const key = flag.slice(2);
    if (Object.hasOwn(out, key)) throw new StartRefused([`${flag} given twice`]);
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new StartRefused([`${flag} needs a value`]);
    out[key] = argv[++i];
  }
  for (const k of REQUIRED) if (typeof out[k] !== "string") throw new StartRefused([`--${k} is required`]);
  return out;
}

/** An owner-custodied file: a regular file of this user, never a symlink, no group or other access. */
export function readOwnerFile(path, what) {
  let st;
  try { st = lstatSync(path); } catch { throw new StartRefused([`${what} missing`]); }
  if (st.isSymbolicLink() || !st.isFile()) throw new StartRefused([`${what} must be a regular file, not a symlink`]);
  if ((st.mode & 0o077) !== 0) throw new StartRefused([`${what} must have no group or other access (mode 0600)`]);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new StartRefused([`${what} must be owned by this user`]);
  return readFileSync(path, "utf8");
}

/** The relay key seed file: exactly one 64-hex seed. */
export function loadRelayKeySeed(path) {
  const seed = readOwnerFile(path, "--relay-key-file").replace(/\n$/, "");
  if (!/^[0-9a-f]{64}$/.test(seed)) throw new StartRefused(["--relay-key-file must hold exactly one 64-hex key seed"]);
  return seed;
}

/** A signed roster or policy file: JSON {body, sig}; its signature and contents are checked by openRelay. */
export function loadSignedFile(path, what) {
  let parsed;
  try { parsed = JSON.parse(readOwnerFile(path, what)); } catch (error) { if (error instanceof StartRefused) throw error; throw new StartRefused([`${what} is not JSON`]); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).sort().join(",") !== "body,sig")
    throw new StartRefused([`${what} must be a signed file {body, sig}`]);
  return parsed;
}

/** An access log path: absent, or an owner-only regular file. */
function checkLogPath(path) {
  let st;
  try { st = lstatSync(path); } catch { return; }
  if (st.isSymbolicLink() || !st.isFile() || (st.mode & 0o077) !== 0 || (typeof process.getuid === "function" && st.uid !== process.getuid()))
    throw new StartRefused(["--access-log must be absent or a private regular file of this user"]);
}

/** The production command line. Exit status 2 on any refusal, before anything listens. */
export async function serveMain(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let relay, db;
  try {
    const o = parseServeArgs(argv);
    // The aud and the bind first: nothing is read before they pass.
    checkStart({ aud: o.aud, host: o.bind, mode: "production" });
    const port = o.port === undefined ? 0 : /^(0|[1-9][0-9]{0,4})$/.test(o.port) && Number(o.port) <= 65535 ? Number(o.port) : NaN;
    if (Number.isNaN(port)) throw new StartRefused(["--port must be 0-65535"]);
    if (!/^[0-9a-f]{64}$/.test(o["owner-public-key"])) throw new StartRefused(["--owner-public-key must be 64 lower-case hex"]);
    process.umask(0o077);
    const seed = loadRelayKeySeed(o["relay-key-file"]);
    const roster = loadSignedFile(o.roster, "--roster"), policy = loadSignedFile(o.policy, "--policy");
    if (o["access-log"] !== undefined) checkLogPath(o["access-log"]);
    db = openRelay({ path: o.db, roster, policy, ownerPublicKey: o["owner-public-key"], now: Date.now() });
    const log = o["access-log"];
    const accessLog = (entry) => {
      const line = `${JSON.stringify(entry)}\n`;
      if (log) appendFileSync(log, line, { mode: 0o600 }); else stderr.write(`access ${line}`);
    };
    relay = await startRelay({ db, aud: o.aud, host: o.bind, port, relayKeySeedHex: seed, accessLog, mode: "production",
      onError: (error) => stderr.write(`relay error: ${String(error?.stack ?? error).slice(0, 2000)}\n`) });
  } catch (error) {
    stderr.write(`${error instanceof StartRefused ? error.message : `relay start refused: ${String(error?.message ?? error).slice(0, 500)}`}\n`);
    try { db?.close(); } catch { /* already closed */ }
    process.exitCode = 2;
    return null;
  }
  stdout.write(`${JSON.stringify({ listening: relay.url, relay_public_key: relay.publicKey, mode: relay.mode, aud: argv[argv.indexOf("--aud") + 1] })}\n`);
  const shutdown = async () => { await relay.close(); db.close(); process.exit(0); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return relay;
}

const invoked = (() => { try { return process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (invoked) await serveMain();
