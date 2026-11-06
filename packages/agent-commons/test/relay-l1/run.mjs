// L1 acceptance runner (spec v3.4.5 13.2, R6; L1 item 10). Drives the scenario on a backend and writes
// the run record. Exit 0 alone is not a pass: the record holds every assertion's result.
//
//   node test/relay-l1/run.mjs --backend docker --commit <sha> --out <record.json> [--counting]
//   node test/relay-l1/run.mjs --backend local --out <record.json>
//
// The docker run follows the scope seat's procedure for item 10 (env-docker.mjs). A run is NON-COUNTING
// unless --counting is given, which is only for the fresh run at exactly candidate C after the security
// review and the verifier both PASS (the B items). The local backend is always non-counting.

import { writeFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { runAcceptance, T0 } from "./scenario.mjs";
import { NOT_EGRESS } from "./egress-sensor-kinds.mjs";
import { RELAY_TEST_AUD } from "../../src/relay/auth.mjs";

const PKG = fileURLToPath(new URL("../../", import.meta.url));
const REPO = realpathSync(new URL("../../../../", import.meta.url));

export async function main(argv = process.argv.slice(2)) {
  const o = { backend: "local" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--counting") { o.counting = true; continue; }
    o[argv[i].replace(/^--/, "")] = argv[++i];
  }
  const runId = `relay-l1-${randomBytes(4).toString("hex")}`;
  const commit = o.commit ?? execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const record = { v: "commons-relay-l1-run/1", run_id: runId, backend: o.backend, counting: o.backend === "docker" && o.counting === true,
    label: o.backend === "docker" && o.counting ? "COUNTING (candidate C, after security review + verifier PASS)" : "NON-COUNTING rehearsal",
    commit, host_node: process.version, aud: RELAY_TEST_AUD, t0: T0, started_at: new Date().toISOString() };
  const log = (m) => { process.stderr.write(`[${new Date().toISOString()}] ${m}\n`); };
  let env;
  try {
    if (o.backend === "docker") {
      const { dockerEnv } = await import("./env-docker.mjs");
      env = await dockerEnv({ commit, pkgRepo: REPO, runId, log, record });
    } else {
      const { localEnv } = await import("./env-local.mjs");
      env = await localEnv({ log });
    }
    const result = await runAcceptance(env, { log }).catch((e) => ({ ok: false, cases: e.cases ?? [], error: String(e?.stack ?? e).slice(0, 3000) }));
    record.relay_public_key = env.relayPublicKey;
    record.cases = result.cases;
    if (result.error) record.error = result.error;
    const events = await env.egress();
    record.egress = { events: events.length, not_egress_kinds: NOT_EGRESS, egress: events.filter(e => !NOT_EGRESS.includes(e.kind)), armed: events.filter(e => e.kind === "sensor.armed").length };
    record.ok = result.ok === true && record.egress.egress.length === 0 && record.egress.armed > 0;
  } catch (error) {
    record.ok = false;
    record.error = String(error?.stack ?? error).slice(0, 4000);
  } finally {
    try { await env?.close(); } catch (error) { record.close_error = String(error).slice(0, 500); }
    record.finished_at = new Date().toISOString();
    if (record.cleanup) record.ok = record.ok && record.cleanup.containers_left === 0 && !record.cleanup.network_left && record.image_count_before === record.image_count_after;
    const text = `${JSON.stringify(record, null, 1)}\n`;
    if (o.out) writeFileSync(o.out, text, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ ok: record.ok, run_id: runId, backend: record.backend, label: record.label, cases: (record.cases ?? []).map(c => [c.id, c.ok]), record_sha256: createHash("sha256").update(text).digest("hex") })}\n`);
    process.exitCode = record.ok ? 0 : 1;
  }
}

const invoked = (() => { try { return process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (invoked) await main();
