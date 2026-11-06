// L1 item 8 (spec v3.4.5 9.3 "A truncated tail is L1"; Addendum C2; RT2 "the relay-signed export
// head covers all logs"): the export carries a relay-signed head over EVERY log's {log, count,
// head_hash}. Given the pinned relay key, verifyExport refuses a truncated tail of any log (the
// security log included), a full rewrite of any chain, a head that leaves a log out, a head signed by
// another key, a missing head, and a head from another relay epoch. Scratch databases, fixture keys.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { jcs } from "../src/pillar.mjs";
import { exportRelay, exportRelaySigned, verifyExport, verifyLogRows, logHeads, RELAY_LOGS, EXPORT_HEAD_V, GENESIS, sha256Hex } from "../src/relay/signing.mjs";
import { RELAY_TEST_AUD } from "../src/relay/auth.mjs";
import { setup, scratch, seatMessage, sendSeatMessage, promoteC1, T0 } from "./relay-fixtures.mjs";

const CLI = fileURLToPath(new URL("../src/relay/export-cli.mjs", import.meta.url));
const relaySeed = () => randomBytes(32).toString("hex");
const pub = (seedHex) => Buffer.from(ed25519.getPublicKey(Buffer.from(seedHex, "hex"))).toString("hex");
const roster = (fx) => fx.files.roster.body.principals;
const reasons = (r) => r.problems.filter(p => p.kind === "export-head").map(p => `${p.id}:${p.reason}`);
const clone = (x) => JSON.parse(JSON.stringify(x));
/** Re-sign a head body with a given relay seed (a relay that signs a different head). */
const resign = (exp, seedHex, body) => ({ ...exp, head: { body, sig: Buffer.from(ed25519.sign(Buffer.from(jcs(body), "utf8"), Buffer.from(seedHex, "hex"))).toString("hex") } });
/** Recompute a log chain from the edited events (a full rewrite: verifyLogRows alone accepts it). */
function rewriteChain(rows, log) {
  let prev = GENESIS;
  for (const r of rows.filter(x => x.log === log).sort((a, b) => a.seq - b.seq)) {
    r.prev = prev;
    r.hash = sha256Hex(`${prev}\n${jcs({ log, seq: r.seq, at: r.at, event: JSON.parse(r.event) })}`);
    prev = r.hash;
  }
}
/** A relay with activity in all five logs. */
function busy() {
  const fx = setup({ members: ["A"] });
  promoteC1(fx, "A");                                                           // board (heartbeat), decision (role.c1)
  sendSeatMessage(fx.db, seatMessage(fx, "seat-1", fx.members.A.id, "hello"), T0);   // mailbox
  return fx;
}

test("9.3 / C2: the head commits to every log's {log, count, head_hash}; a clean export verifies with the pinned relay key", () => {
  const fx = busy();
  const seed = relaySeed();
  const exp = exportRelaySigned(fx.db, { relaySeedHex: seed, aud: RELAY_TEST_AUD, at: T0 });
  assert.deepEqual(RELAY_LOGS, ["board", "decision", "enrollment", "mailbox", "security"]);
  assert.deepEqual(exp.head.body.logs.map(l => l.log), RELAY_LOGS);
  for (const l of exp.head.body.logs) assert.ok(l.count > 0, `${l.log} has events in this fixture`);
  assert.deepEqual(exp.head.body.logs, logHeads(exp.logs));
  assert.deepEqual([exp.head.body.v, exp.head.body.aud, exp.head.body.epoch, exp.head.body.at], [EXPORT_HEAD_V, RELAY_TEST_AUD, exp.epoch, T0]);
  const r = verifyExport(exp, roster(fx), { relayPublicKey: pub(seed), aud: RELAY_TEST_AUD });
  assert.deepEqual(r.problems, []);
  // The L0 export (no relay key) still verifies as before.
  assert.deepEqual(verifyExport(exportRelay(fx.db), roster(fx)).problems, []);
});

test("a truncated tail of ANY log is refused against the head (security log included); a full chain rewrite too", () => {
  const fx = busy();
  const seed = relaySeed();
  const exp = exportRelaySigned(fx.db, { relaySeedHex: seed, aud: RELAY_TEST_AUD, at: T0 });
  for (const log of RELAY_LOGS) {
    const cut = clone(exp);
    const last = Math.max(...cut.logs.filter(r => r.log === log).map(r => r.seq));
    cut.logs = cut.logs.filter(r => !(r.log === log && r.seq === last));
    assert.ok(reasons(verifyExport(cut, roster(fx), { relayPublicKey: pub(seed) })).includes(`${log}:head-count-mismatch`), `${log}: truncated tail`);
    // Without the head, the truncated chain alone still links (this is the gap the head closes).
    assert.equal(verifyLogRows(cut.logs).ok, true, `${log}: the cut chain links`);
  }
  // A full rewrite of the security log: the chain re-links, only the head catches it.
  const rw = clone(exp);
  const row = rw.logs.find(r => r.log === "security");
  row.event = JSON.stringify({ ...JSON.parse(row.event), rewritten: 1 });
  rewriteChain(rw.logs, "security");
  assert.equal(verifyLogRows(rw.logs).ok, true, "the rewritten chain links");
  const r = verifyExport(rw, roster(fx), { relayPublicKey: pub(seed) });
  assert.ok(reasons(r).includes("security:head-hash-mismatch"), JSON.stringify(reasons(r)));
});

test("the head itself: missing, signed by another key, leaving a log out, naming an unknown log, another epoch or aud: each refused", () => {
  const fx = busy();
  const seed = relaySeed();
  const exp = exportRelaySigned(fx.db, { relaySeedHex: seed, aud: RELAY_TEST_AUD, at: T0 });
  const opts = { relayPublicKey: pub(seed), aud: RELAY_TEST_AUD };
  assert.deepEqual(reasons(verifyExport({ ...exp, head: undefined }, roster(fx), opts)), ["head:head-missing"]);
  assert.deepEqual(reasons(verifyExport(resign(exp, relaySeed(), exp.head.body), roster(fx), opts)), ["head:head-bad-signature"]);
  const four = { ...exp.head.body, logs: exp.head.body.logs.filter(l => l.log !== "security") };
  assert.deepEqual(reasons(verifyExport(resign(exp, seed, four), roster(fx), opts)), ["security:head-log-missing"], "a head that covers only some logs");
  const extra = { ...exp.head.body, logs: [...exp.head.body.logs, { log: "shadow", count: 0, head_hash: GENESIS }] };
  assert.deepEqual(reasons(verifyExport(resign(exp, seed, extra), roster(fx), opts)), ["shadow:head-log-unknown"]);
  assert.deepEqual(reasons(verifyExport(resign(exp, seed, { ...exp.head.body, epoch: "0".repeat(32) }), roster(fx), opts)), ["head:head-epoch-mismatch"]);
  assert.deepEqual(reasons(verifyExport(resign(exp, seed, { ...exp.head.body, aud: "http://commons-relay.test:8081" }), roster(fx), opts)), ["head:head-aud-mismatch"]);
  assert.deepEqual(reasons(verifyExport(exp, roster(fx), { relayPublicKey: "0".repeat(64) })), ["head:head-bad-signature"], "a key that is not a strict point");
});

test("export CLI: the test aud or an L2 https origin, and a 0600 relay key only; writes the signed export, which verifies offline; exit 2 otherwise", () => {
  const fx = setup({ members: ["A"], path: scratch().path });
  const { dir } = scratch();
  const seed = relaySeed();
  const keyFile = join(dir, "relay.key"), out = join(dir, "export.json");
  writeFileSync(keyFile, `${seed}\n`, { mode: 0o600 });
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED: "0" } });
  const base = ["--db", fx.path, "--relay-key-file", keyFile, "--out", out, "--at", String(T0)];
  // L2: the export takes the L1 test aud or a canonical https origin; anything else exits 2.
  for (const aud of ["http://commons.example.org", "https://commons.example.org/", "https://commons-relay.test:8080"]) {
    const bad = run([...base, "--aud", aud]);
    assert.equal(bad.status, 2, aud);
    assert.match(bad.stderr, /aud must be/);
  }
  const loose = join(dir, "loose.key");
  writeFileSync(loose, `${seed}\n`, { mode: 0o644 });
  assert.equal(run(["--db", fx.path, "--relay-key-file", loose, "--out", out, "--aud", RELAY_TEST_AUD]).status, 2);
  const ok = run([...base, "--aud", RELAY_TEST_AUD]);
  assert.equal(ok.status, 0, ok.stderr);
  const exp = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(verifyExport(exp, roster(fx), { relayPublicKey: pub(seed), aud: RELAY_TEST_AUD }).problems, []);
  assert.equal(readFileSync(out, "utf8").includes(seed), false, "N22: the relay key seed is never in the export");
});
