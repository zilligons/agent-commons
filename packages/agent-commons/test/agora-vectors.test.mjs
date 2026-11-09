// The shipped Agora vectors (examples/agora-vectors/agora-v1.json) were approved byte-for-byte by the LIVE uuaid
// verifiers (cf48f0e @uuaid/core verifyEnvelope + canonicalize, identity-binding verifyIdentityBindingSignature).
// CI cannot run that oracle, so it proves the next best thing: this build reproduces those exact bytes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildVectors } from "../scripts/generate-agora-vectors.mjs";

const shipped = JSON.parse(readFileSync(new URL("../examples/agora-vectors/agora-v1.json", import.meta.url), "utf8"));

test("agora vectors: this build reproduces every oracle-approved byte (envelopes, bindings, JCS)", () => {
  const now = buildVectors();
  assert.equal(now.cases.length, 3);
  for (const [i, c] of now.cases.entries()) {
    assert.deepEqual(c.envelope, shipped.cases[i].envelope, `envelope ${c.namespace}`);
    assert.deepEqual(c.binding, shipped.cases[i].binding, `binding ${c.namespace}`);
  }
  assert.deepEqual(now.jcs, shipped.jcs);
});

test("agora vectors are not vacuous: a one-byte change to the JCS order breaks them", () => {
  const sorted = Object.keys(shipped.jcs[1].value).sort();
  const byBytes = [...sorted].sort((a, b) => Buffer.compare(Buffer.from(a, "utf16le"), Buffer.from(b, "utf16le")));
  assert.notDeepEqual(byBytes, sorted, "UTF-16LE byte order differs from code-unit order on this case, so a wrong JCS fails it");
});
