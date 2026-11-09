import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runWildVectors, WILD_VECTORS_URL } from "../src/conformance.mjs";
import { AgentCommons } from "../src/runtime.mjs";

test("wild vectors: this build hears every shipped wild-format case and refuses every rejection case", async () => {
  const r = await runWildVectors();
  assert.equal(r.failed, 0, JSON.stringify(r.cases.filter((c) => !c.ok), null, 2));
  assert.equal(r.passed, 10);
  // This build refuses each rejection vector for the documented reason, not by accident.
  const vectors = JSON.parse(readFileSync(WILD_VECTORS_URL, "utf8"));
  const pinned = vectors.cases.filter((c) => c.referenceRefusal);
  assert.equal(pinned.length, 4);
  for (const c of pinned) assert.equal(r.cases.find((x) => x.name === c.name).steps[0].got.reason, c.referenceRefusal, c.name);
});

test("wild vectors are not vacuous: the old strict ingress FAILS them", async () => {
  const original = AgentCommons.prototype.receivePlain;
  AgentCommons.prototype.receivePlain = function () { throw new Error("Invalid or expired Agent Commons payload"); };
  try {
    const r = await runWildVectors();
    const failed = r.cases.filter((c) => !c.ok).map((c) => c.name).sort();
    assert.deepEqual(failed, ["group-manifest-invitation", "plain-dm", "plain-dm-any-shape", "plain-dm-foreign-version", "plain-in-space-message"]);
    // The stranger case passes either way: strangers were and still are refused.
    assert.equal(r.cases.find((c) => c.name === "plain-dm-stranger").ok, true);
  } finally { AgentCommons.prototype.receivePlain = original; }
});

test("rejection vectors are not vacuous: a build that hears everything FAILS them", async () => {
  const original = AgentCommons.prototype.receive;
  AgentCommons.prototype.receive = async function (envelope) { return { accepted: true, format: "pillar-plain", sender: envelope.sender, payload: {} }; };
  try {
    const r = await runWildVectors();
    const failed = r.cases.filter((c) => !c.ok).map((c) => c.name).sort();
    for (const name of ["plain-dm-stranger", "reject-bad-signature", "reject-key-mismatch", "reject-malformed-commons", "reject-non-object"]) assert.ok(failed.includes(name), `${name} must catch false acceptance`);
  } finally { AgentCommons.prototype.receive = original; }
});

test("wild vectors: a tampered envelope is refused, so a passing run is meaningful", async () => {
  const vectors = JSON.parse(readFileSync(WILD_VECTORS_URL, "utf8"));
  vectors.cases[0].envelopes[0].enc.ct = vectors.cases[0].envelopes[0].enc.ct.replace(/^./, (c) => (c === "A" ? "B" : "A"));
  const r = await runWildVectors({ vectors });
  assert.equal(r.cases[0].ok, false);
  assert.equal(r.cases[0].steps[0].got.runtime, "refused");
});

test("wild vectors: the CLI 'conformance' command reports 10/10 and exits 0", () => {
  const bin = fileURLToPath(new URL("../bin/agent-commons.mjs", import.meta.url));
  const out = spawnSync(process.execPath, [bin, "conformance"], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  const report = JSON.parse(out.stdout);
  assert.equal(report.passed, 10);
  assert.equal(report.failed, 0);
});
