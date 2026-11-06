// Worker for test/relay-concurrency.test.mjs: one relay operation on its own
// SQLite connection to a scratch relay*.db. Each worker opens its connection,
// waits at a shared barrier until every party is ready, then runs its operation
// and reports the outcome. Signed bodies are built by the main thread.

import { workerData, parentPort } from "node:worker_threads";
import { openRelayDb } from "../src/relay/schema.mjs";
import { handleMemberRecord } from "../src/relay/board.mjs";
import { createDecision, addVerdict, declareCoauthor, settleAll } from "../src/relay/governance.mjs";

process.env.AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED = "0";

const OPS = {
  member: (db, a) => handleMemberRecord(db, a.memberId, a.record, a.now),
  decision: (db, a) => createDecision(db, a.signed, a.now),
  verdict: (db, a) => addVerdict(db, a.signed, a.now),
  coauthor: (db, a) => declareCoauthor(db, a.signed, a.now),
  settle: (db, a) => settleAll(db, a.now),
};

const { path, barrier, parties, op, args } = workerData;
// "open" (N6) opens its connection only after the barrier, so both workers race the first open.
const db = op === "open" ? null : openRelayDb(path);
const gate = new Int32Array(barrier);
Atomics.add(gate, 0, 1);
Atomics.notify(gate, 0);
for (let seen; (seen = Atomics.load(gate, 0)) < parties;) Atomics.wait(gate, 0, seen, 50);
let outcome;
try {
  if (op === "open") {
    const fresh = openRelayDb(path);
    outcome = { ok: true, result: fresh.prepare("SELECT k, v FROM meta ORDER BY k").all().map(r => ({ ...r })) };
    fresh.close();
  } else outcome = { ok: true, result: JSON.parse(JSON.stringify(OPS[op](db, args))) };
} catch (error) {
  outcome = { ok: false, code: error.code ?? null, message: String(error.message) };
} finally {
  db?.close();
}
parentPort.postMessage(outcome);
