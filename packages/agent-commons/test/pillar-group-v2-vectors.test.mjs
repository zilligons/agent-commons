import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadVectors, runAll } from "./vectors/runner.mjs";
import * as groupsV2 from "../src/vendor/pillar/groups-v2.mjs";

// V-2 (design rev 3, slice 1): run pillar's own shared vectors against the
// byte-identical vendored engine. The runner is pillar's; its checks are reused
// as-is, never rewritten. This file never loads
// test/fixtures/ed25519-small-order.vectors.json (2 entries) — that fixture is
// not V-2.
const VECTORS_SHA256 = "4c456ca555e5b9f1c4082ea720a4c4bd50affa8e5200095eeff11aa82a7f8c28";
const RUNNER_SHA256 = "36b29564f28aaa90ab9c8eb0308b9b843c6d36e666404c5fe7b894e378e5686c";

const sha256 = (rel) =>
  createHash("sha256").update(readFileSync(new URL(rel, import.meta.url))).digest("hex");

test("vendored shared-vector files are byte-identical to the pinned blobs", () => {
  assert.equal(sha256("./vectors/pillar-group-v2.vectors.json"), VECTORS_SHA256, "vectors sha256");
  assert.equal(sha256("./vectors/runner.mjs"), RUNNER_SHA256, "runner sha256");
});

test("loadVectors returns the pinned 30 manifests and 34 scenarios", () => {
  const vectors = loadVectors();
  assert.equal(vectors.manifests.length, 30, "30 manifests");
  assert.equal(vectors.scenarios.length, 34, "34 scenarios");
});

test("vendored groups-v2 agrees with every shared vector", () => {
  const vectors = loadVectors();
  const { results, agree, disagree } = runAll(groupsV2, vectors);
  assert.equal(disagree, 0, `0 disagreements (agree=${agree}/${results.length})`);
});
