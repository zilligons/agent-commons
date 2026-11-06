// Cloud Commons relay: write the relay-signed export (spec v3.4.5 9.3: a truncated log tail is detected;
// the relay-signed export head covers all logs). Run where the relay key lives (on
// the relay's own host or container); it opens relay.db, opens no listener and makes no network call.
//
// node src/relay/export-cli.mjs --db <relay*.db> --relay-key-file <0600 file, 64-hex seed>
//   --aud <the relay's aud: the test aud, or a production https origin> --out <file> [--at <ms>]
// The output is exportRelay(db) plus `head` = {body: {v, aud, epoch, at, logs: [{log, count,
// head_hash}] for every log}, sig}, both read in one snapshot. Exit status 2 on any refusal.

import { writeFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { RELAY_TEST_AUD } from "./auth.mjs";
import { openRelayDb } from "./schema.mjs";
import { exportRelaySigned } from "./signing.mjs";
import { readPrivateFile, StartRefused, isProductionAud } from "./server.mjs";

const FLAGS = Object.freeze(["--db", "--relay-key-file", "--aud", "--out", "--at"]);

export function exportMain(argv = process.argv.slice(2), { stderr = process.stderr, now = Date.now } = {}) {
  let db;
  try {
    const o = {};
    for (let i = 0; i < argv.length; i += 2) {
      if (!FLAGS.includes(argv[i]) || i + 1 >= argv.length || Object.hasOwn(o, argv[i].slice(2))) throw new StartRefused([`bad argument ${JSON.stringify(String(argv[i]).slice(0, 40))}`]);
      o[argv[i].slice(2)] = argv[i + 1];
    }
    if (o.aud !== RELAY_TEST_AUD && !isProductionAud(o.aud)) throw new StartRefused([`aud must be ${RELAY_TEST_AUD} (L1) or a canonical https origin (L2)`]);
    for (const k of ["db", "relay-key-file", "out"]) if (typeof o[k] !== "string") throw new StartRefused([`--${k} is required`]);
    const at = o.at === undefined ? now() : /^(0|[1-9][0-9]{0,15})$/.test(o.at) ? Number(o.at) : NaN;
    if (!Number.isSafeInteger(at)) throw new StartRefused(["--at must be an integer (ms)"]);
    const seed = readPrivateFile(o["relay-key-file"], "--relay-key-file").trim();
    if (!/^[0-9a-f]{64}$/.test(seed)) throw new StartRefused(["--relay-key-file must hold one 64-hex key seed"]);
    db = openRelayDb(o.db);
    const exp = exportRelaySigned(db, { relaySeedHex: seed, aud: o.aud, at });
    writeFileSync(o.out, `${JSON.stringify(exp)}\n`, { mode: 0o600 });
    return exp.head.body;
  } catch (error) {
    stderr.write(`relay export refused: ${String(error?.message ?? error).slice(0, 500)}\n`);
    process.exitCode = 2;
    return null;
  } finally {
    try { db?.close(); } catch { /* closed */ }
  }
}

const invoked = (() => { try { return process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (invoked) exportMain();
