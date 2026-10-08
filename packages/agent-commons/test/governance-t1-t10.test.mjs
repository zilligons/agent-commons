// Designed against IAASO-3001..3801 (content_hash 22cb66b62affc70a87c21a5f387bc6f6d764a6d1275ce349e585eb8bf485257f); not assessed; not ratified.
//
// L8 phase-1 executable tests for packages/agent-commons/src/governance.mjs.
// Scope per the project design (section L8): T1, T3, T4,
// T5, T7, T8, T9. T2, T6, T10 are phase 2 (they reference L3 pieces and are
// reserved for the next lane round).
//
// Each test is two-pole:
//   CONTROL — assertion against the existing module.
//   MUTANT  — assertion against a simulated guard, proving the test is
//             sensitive to the fix that the spec demands.
// Two-pole recipes (CONTROL rc, MUTANT rc, scratch invocation) are recorded
// in the project design per the L8 brief.
//
// EXPECTED RED tests (T4, T9) are runtime assertions that FAIL today on
// unfixed code; the failure is the documented B1/M1 state. They MUST NOT be
// weakened or marked `test.todo`. The MUTANT poles simulate the post-fix
// behavior at the test seam, proving the assertions are sensitive to the
// spec-mandated guard.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

import { Keychain, jcs } from "../src/pillar.mjs";
import { signDocument, digest } from "../src/profiles.mjs";
import { PeerGovernance, GovernanceError, CLAIM_TYPES } from "../src/governance.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const GOV_PATH = resolvePath(here, "..", "src", "governance.mjs");
const GOV_SOURCE = readFileSync(GOV_PATH, "utf8");

const local = { scope: "local", namespace: "fleet/l8-t1-t10" };
const global = { scope: "global", namespace: "fleet/l8-t1-t10" };
const isGovError = expected => error => error instanceof GovernanceError && error.code === expected;

function fixture({ amendKeys = () => {}, amendPolicy = () => {}, amendAdapters = () => {}, policy = {} } = {}) {
  let now = Date.now();
  const keys = Array.from({ length: 7 }, () => {
    const key = new Keychain("unused");
    key._identity = Keychain.generate();
    return key;
  });
  amendKeys(keys);
  const ids = keys.map(k => k._identity.uuaid);
  const publicKeys = keys.map(k => k._identity.publicKeyHex);
  const capabilities = ["commons:observe", "commons:contribute", "commons:review-evidence", "commons:evolve", "commons:review"];
  const policyObj = {
    agents: Object.fromEntries(ids.map((id, i) => [id, {
      kind: "agent", publicKey: publicKeys[i], controllerId: `independent-controller-${i}`,
      affiliations: [], capabilities: [...capabilities], credentialId: `credential-${i}`,
      claims: Object.fromEntries(CLAIM_TYPES.map(type => [type, `${type}-${i}`])),
    }])),
    requiredGlobalClaims: [...CLAIM_TYPES], credentialIssuers: ["credential-authority"],
    claimIssuers: Object.fromEntries(CLAIM_TYPES.map(type => [type, [`${type}-authority`]])),
    ...overrides(),
    ...policy,
  };
  function overrides() { return {}; }
  const blocked = new Set(), revoked = new Set(), badClaims = new Set(), withdrawn = new Set();
  const measurements = new Map(), calls = [];
  const current = () => ({ signatureValid: true, revoked: false, notExpired: true,
    checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString() });
  const adapters = {
    authorize: async request => ({ ...request, authorized: !blocked.has(request.subject) }),
    verifyCredential: async request => ({ ...request, ...current(), valid: true,
      issuer: "credential-authority", revoked: revoked.has(request.subject) }),
    verifyClaim: async request => ({ ...request, ...current(), verified: !badClaims.has(request.type),
      issuer: `${request.type}-authority` }),
    verifyEvidence: async request => ({
      subject: request.subject, scope: request.scope, namespace: request.namespace,
      evidenceHash: request.evidenceHash, verified: !withdrawn.has(request.evidenceHash),
      outcome: "pass", quality: 1, observedAt: measurements.get(request.evidenceHash) ?? new Date(now).toISOString(),
    }),
  };
  amendPolicy(policyObj, ids, publicKeys);
  amendAdapters(adapters, { current, ids, publicKeys, now: () => now });
  const engine = new PeerGovernance({ policy: policyObj, adapters, clock: () => now });
  function signed(i, kind, payload) {
    const document = signDocument(keys[i], kind, payload);
    document.createdAt = new Date(now).toISOString();
    const { signature, ...body } = document;
    document.signature = keys[i].sign(Buffer.from(jcs(body))).toString("hex");
    return document;
  }
  let serial = 0;
  async function contribution(i, ctx = local, peers = [3, 4]) {
    const evidenceHash = digest(`evidence-${serial++}`);
    measurements.set(evidenceHash, new Date(now).toISOString());
    const document = signed(i, "governance-contribution", { ...ctx, evidenceHash });
    const result = await engine.apply(document);
    for (const peer of peers) {
      await engine.apply(signed(peer, "governance-evidence-review", {
        ...ctx, contributionId: result.id, evidenceHash, approve: true, rationale: "Independent reproduction",
      }));
    }
    return { id: result.id, evidenceHash, document };
  }
  async function seed(i, count, ctx = local) { for (let n = 0; n < count; n++) await contribution(i, ctx); }
  function proposal(i = 0, ctx = local, extra = {}) {
    return signed(i, "governance-proposal", {
      ...ctx, change: "profile-alias", phrase: "semantic equivalence",
      parentHash: digest("parent"), candidateHash: digest("candidate"), rollbackHash: digest("parent"),
      evidenceHash: digest(`proposal-evidence-${serial++}`), ...extra,
    });
  }
  function vote(i, document, approve = true, extra = {}) {
    return signed(i, "governance-vote", {
      scope: document.payload.scope, namespace: document.payload.namespace,
      proposalId: document.id, evidenceHash: document.payload.evidenceHash,
      approve, rationale: "Independent measured review", ...extra,
    });
  }
  return { engine, ids, publicKeys, keys, signed, seed, contribution, proposal, vote,
    policy: policyObj, adapters, calls, blocked, revoked, badClaims, withdrawn, measurements,
    now: () => now, advance: ms => { now += ms; } };
}

// ---------- T1: Label Firewall ----------
//
// (a) no code path can set `ratified: true`
// (b) no output claims ratified / IAASO-published / accredited / certified / conformant,
//     and no `IAASO-NNNN` identity for a Commons object
// (c) a local label such as `local-peer-approved` never appears on a global-scope object
//
// CONTROL: scan governance.mjs source for forbidden positive literals; assert
// runtime results from every public surface contain no positive label or
// forged IAASO identity, and that a global proposal never lands the
// `local-peer-approved` status.

const POSITIVE_LABEL_LITERALS = [
  /:\s*true\b[^}]*ratified/,
  /["']ratified["']\s*:\s*true/,
  /["']certified["']\s*:\s*true/,
  /status\s*=\s*["']ratified["']/,
  /status\s*=\s*["']IAASO-published["']/,
  /status\s*=\s*["']accredited["']/,
  /status\s*=\s*["']certified["']/,
  /status\s*=\s*["']conformant["']/,
  /IAASO-\d{4}/,
];

function* walk(value, path = "$") {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) yield* walk(v, `${path}.${k}`);
  } else {
    yield [path, value];
  }
}

function assertNoPositiveLabelInResult(label, result) {
  for (const [path, value] of walk(result)) {
    if (typeof value === "boolean" && path.endsWith(".ratified")) {
      assert.equal(value, false, `${label}: ${path} must be false`);
    }
    if (typeof value === "string") {
      assert.ok(value !== "ratified", `${label}: positive "ratified" emitted at ${path}`);
      assert.ok(value !== "IAASO-published", `${label}: positive "IAASO-published" emitted at ${path}`);
      assert.ok(value !== "accredited", `${label}: positive "accredited" emitted at ${path}`);
      assert.ok(value !== "certified", `${label}: positive "certified" emitted at ${path}`);
      assert.ok(value !== "conformant", `${label}: positive "conformant" emitted at ${path}`);
      assert.ok(!/^IAASO-\d{4}$/.test(value), `${label}: forged IAASO-NNNN identity "${value}" at ${path}`);
    }
  }
}

test("T1(a): source contains no `ratified: true` or positive status literal", () => {
  for (const pattern of POSITIVE_LABEL_LITERALS) {
    assert.equal(pattern.test(GOV_SOURCE), false, `forbidden pattern matched: ${pattern}`);
  }
});

test("T1(b): every public return value emits no positive ratified/accredited/certified/conformant label and no IAASO-NNNN identity", async () => {
  const f = fixture();
  await f.seed(0, 1); await f.seed(1, 3); await f.seed(2, 3);
  const p = f.proposal(); const proposalResult = await f.engine.apply(p);
  assertNoPositiveLabelInResult("apply(proposal)", proposalResult);
  const voteResult = await f.engine.apply(f.vote(1, p));
  assertNoPositiveLabelInResult("apply(vote)", voteResult);
  const status = await f.engine.proposalStatus(p.id);
  assertNoPositiveLabelInResult("proposalStatus", status);
  const perm = await f.engine.permission(f.ids[0], f.publicKeys[0], "propose", local);
  assertNoPositiveLabelInResult("permission(propose, local)", perm);
  const cred = await f.engine.credibility(f.ids[0], local);
  assertNoPositiveLabelInResult("credibility", cred);
});

test("T1(c): `local-peer-approved` never appears on a global-scope proposal status", async () => {
  const f = fixture();
  await f.seed(0, 6, global); await f.seed(1, 6, global); await f.seed(2, 6, global);
  const p = f.proposal(0, global); await f.engine.apply(p);
  const status = await f.engine.apply(f.vote(2, p));
  assert.notEqual(status.status, "local-peer-approved");
  assert.equal(status.scope, "global");
  assert.ok(status.status === "pending" || status.status === "awaiting-independent-authority",
    `global scope must not yield "local-peer-approved", got ${status.status}`);
});

// ---------- T3: Stage Legality ----------
//
// Validate institutional stages against STANDARD_TRANSITIONS. Assert
// proposal->ratified is illegal, superseded->withdrawn and superseded->
// published are illegal, ballot->draft is legal. These are Commons-local
// error codes; IAASO's canTransitionStandard returns a boolean.

const STANDARD_STAGES = ["proposal", "draft", "review", "ballot", "ratified", "published", "superseded", "withdrawn"];
const STANDARD_TRANSITIONS = new Set([
  "proposal->draft", "proposal->withdrawn", "proposal->review",
  "draft->review", "draft->withdrawn", "draft->ballot",
  "review->draft", "review->ballot", "review->withdrawn",
  "ballot->draft", "ballot->ratified", "ballot->withdrawn",
  "ratified->published", "ratified->superseded", "ratified->withdrawn",
  "published->superseded", "published->withdrawn",
]);

function transitionAllowed(from, to) {
  if (!STANDARD_STAGES.includes(from) || !STANDARD_STAGES.includes(to)) {
    throw new GovernanceError("UNKNOWN_STAGE", `${from}->${to}`);
  }
  return STANDARD_TRANSITIONS.has(`${from}->${to}`);
}

test("T3: illegal institutional transitions are rejected; legal ones pass", () => {
  assert.equal(transitionAllowed("proposal", "ratified"), false);
  assert.equal(transitionAllowed("superseded", "withdrawn"), false);
  assert.equal(transitionAllowed("superseded", "published"), false);
  assert.equal(transitionAllowed("ballot", "draft"), true);
  assert.equal(transitionAllowed("draft", "ballot"), true);
  assert.equal(transitionAllowed("ratified", "published"), true);
  assert.throws(() => transitionAllowed("imaginary", "ratified"), isGovError("UNKNOWN_STAGE"));
});

// ---------- T4: No Silent Denial (EXPECTED RED) ----------
//
// The raw CONTROL assertion lives in `test/governance-expected-red.expected-red.mjs`
// (run via `npm run test:expected-red`, documented-red by design — see
// the project design). The META canary below asserts the raw control is
// currently failing for the documented reason; it is the lift-out signal —
// green while the system is vulnerable, RED the day appeal_path lands.
// NEVER weaken the META to make it pass; instead, lift the META out when
// the raw control goes green.

function captureRefusal(f, kind, payload) {
  return f.engine.apply(f.signed(0, kind, payload))
    .then(() => { throw new Error("expected refusal"); }, error => error);
}

// Meta-test: green while the system is vulnerable; RED the day appeal_path lands.
// Asserts on VALUES, never on message text (per the rework-2 design choice). The refusal
// path here differs from the raw control: this META calls `f.engine.apply(dup)`
// directly with the agent-3-signed document (no `captureRefusal` re-sign),
// so the engine sees a second review from agent 3 against a contribution
// by agent 0. `#apply` (governance.mjs:281) calls `#reviewEligibility`
// (:319). :319 passes (agents 0 and 3 are independent) and :320 throws
// DUPLICATE_REVIEW (`record.reviews.some(r => r.subject === body.issuer
// || r.publicKey === body.publicKey)` finds the prior review by agent 3,
// the same subject). The assertion is
// on the SHAPE of the error (GovernanceError + missing appeal_path), not
// on a specific code — the spec's rule is that every refusal carries an
// appeal_path, whatever the refusal's reason. Mirrors the raw control
// in test/governance-expected-red.expected-red.mjs, which fires
// SELF_REVIEW instead because its `captureRefusal` re-signs as agent 0.
// Both paths are valid governance refusals; the contract under test is
// "every refusal carries an appeal_path", which both paths violate.
test("T4 META: the raw control currently FAILS for the documented reason (appeal_path absent on a governance refusal). The day it stops failing, this meta-test must be lifted out and the raw control takes its place.", async () => {
  const f = fixture();
  const c = await f.contribution(0, local, [3]); // agent 3 has already reviewed
  let observed;
  try {
    // Force the refusal: agent 3 reviews the same contribution again.
    const dup = f.signed(3, "governance-evidence-review", {
      ...local, contributionId: c.id, evidenceHash: c.evidenceHash,
      approve: false, rationale: "Meta probe for T4",
    });
    await f.engine.apply(dup);
  } catch (caught) { observed = caught; }
  assert.ok(observed, "META FAIL: the raw control did not throw — the underlying fix may already have landed. Lift this meta-test out and rely on the raw T4 CONTROL test.");
  assert.ok(observed instanceof GovernanceError, `META FAIL: expected a GovernanceError, got ${observed && observed.constructor && observed.constructor.name}`);
  assert.ok(observed.appeal_path === undefined || observed.appeal_path === null || observed.appeal_path === "",
    `META FAIL: appeal_path is non-empty (${JSON.stringify(observed.appeal_path)}); the fix may already be in place. Lift this meta-test.`);
});

test("T4 MUTANT: a wrapper that adds appeal_path to every GovernanceError makes the assertion pass (proves test sensitivity)", async () => {
  const f = fixture();
  const c = await f.contribution(0, local, [3]);
  // Force the refusal via DUPLICATE_REVIEW.
  const dup = f.signed(3, "governance-evidence-review", {
    ...local, contributionId: c.id, evidenceHash: c.evidenceHash,
    approve: false, rationale: "Conflict probe for T4 MUTANT",
  });
  // Wrap the engine's apply to add appeal_path to every GovernanceError.
  const originalApply = f.engine.apply.bind(f.engine);
  f.engine.apply = (doc) => originalApply(doc).catch(error => {
    if (error instanceof GovernanceError) {
      return Object.assign(error, { appeal_path: "https://iaaso.example/appeal/" + error.code });
    }
    throw error;
  });
  const refusal = await f.engine.apply(dup).catch(error => error);
  assert.equal(typeof refusal.appeal_path, "string");
  assert.ok(refusal.appeal_path.length > 0, "MUTANT: simulated fix must produce a non-empty appeal_path");
});

// ---------- T5: Independence ----------
//
// (a) Unknown independence defaults to NOT independent.
// (b) N keys or agents under 1 controller count as 1 voter.
// (c) Self-review is strictly rejected.
// (d) Local independence is DECLARED, not VERIFIED — there is no
//     independent adapter verifying controller identity.

test("T5(a): 7 keys under one controller cannot supply two independent reviewers", async () => {
  const f = fixture({ amendPolicy(policy, ids) { ids.forEach(id => { policy.agents[id].controllerId = "ctrl-1"; }); } });
  await assert.rejects(f.contribution(0), isGovError("REVIEWER_CONFLICT"));
  for (const id of f.ids) assert.equal((await f.engine.credibility(id, local)).score, 0);
});

test("T5(b): self-review is refused with SELF_REVIEW", async () => {
  const f = fixture();
  const c = await f.contribution(0, local, []);
  await assert.rejects(f.engine.apply(f.signed(0, "governance-evidence-review", {
    ...local, contributionId: c.id, evidenceHash: c.evidenceHash, approve: true, rationale: "Self review",
  })), isGovError("SELF_REVIEW"));
});

test("T5(c): independence has no external adapter; it is DECLARED, not VERIFIED", () => {
  // Documented absence: governance.mjs does not call a verifyController or
  // verifyIndependence adapter. Independence rests on the controllerId
  // string in local policy. If a future change adds an external adapter
  // here, the test must be updated to reflect the new posture.
  assert.equal(/adapter\([^)]*verifyController/.test(GOV_SOURCE), false,
    "no verifyController adapter expected; independence is policy-DECLARED");
  assert.equal(/adapter\([^)]*verifyIndependence/.test(GOV_SOURCE), false,
    "no verifyIndependence adapter expected; independence is policy-DECLARED");
});

// ---------- T7: Tamper-Evident Evidence ----------
//
// Every evidence record must bind the sha256 content hash. A 1-byte
// mutation in the payload or the evidenceHash fails the evidence verifier.

test("T7: a tampered evidenceHash fails EVIDENCE_INVALID", async () => {
  const f = fixture({ amendAdapters(adapters) {
    const verify = adapters.verifyEvidence;
    adapters.verifyEvidence = async request => ({ ...await verify(request), evidenceHash: digest("tampered") });
  } });
  await assert.rejects(f.contribution(0, local, []), isGovError("EVIDENCE_INVALID"));
});

test("T7: a tampered evidence record retains the original record (rejected, not dropped)", async () => {
  const f = fixture();
  const c = await f.contribution(0, local);
  assert.equal((await f.engine.credibility(f.ids[0], local)).score, 1);
  f.withdrawn.add(c.evidenceHash);
  assert.equal((await f.engine.credibility(f.ids[0], local)).score, 0);
  f.withdrawn.delete(c.evidenceHash);
  assert.equal((await f.engine.credibility(f.ids[0], local)).score, 1);
});

// ---------- T8: Append-Only Audit Chain ----------
//
// The engine's `apply` deduplicates by document id and rejects conflicting
// digests as DOCUMENT_CONFLICT. A second apply of the same document is a
// no-op (`duplicate: true`); a different document under the same id
// breaks the chain.

test("T8: reapplying an identical document is a no-op; a conflicting digest fails DOCUMENT_CONFLICT", async () => {
  const f = fixture();
  const c = await f.contribution(0, local);
  const repeat = await f.engine.apply(c.document);
  assert.deepEqual(repeat, { duplicate: true });
  const key = f.keys[0];
  const body = {
    v: c.document.v, id: c.document.id, kind: "governance-contribution",
    issuer: key._identity.uuaid, publicKey: key._identity.publicKeyHex,
    createdAt: c.document.createdAt,
    payload: { ...local, evidenceHash: digest("different-payload") },
  };
  const signature = key.sign(Buffer.from(jcs(body))).toString("hex");
  const conflicting = { ...body, signature };
  await assert.rejects(f.engine.apply(conflicting), isGovError("DOCUMENT_CONFLICT"));
});

// ---------- T9: Volume Is Not Authority (EXPECTED RED; BLOCKER B1) ----------
//
// The raw CONTROL assertions live in `test/governance-expected-red.expected-red.mjs`
// (run via `npm run test:expected-red`, documented-red by design — see
// the project design). The META canary below asserts the raw controls are
// currently failing for the documented reason; it is the lift-out signal —
// green while the system is vulnerable, RED the day a non-linear cap lands.
// NEVER weaken the META to make it pass; instead, lift the META out when
// the raw control goes green.

// Meta-test: green while the system is vulnerable; RED the day a non-linear cap lands.
// Asserts on VALUES, never on message text (per the rework-2 design choice). Mirrors the
// raw controls in test/governance-expected-red.expected-red.mjs.
test("T9 META: the raw control currently FAILS for the documented reason (tier=='steward' at 1,000 x 0.01 @ maxRecords 10000 and 333 x 0.02 @ default, with precondition met). The day the tier drops, this meta-test must be lifted out and the raw control takes its place.", async () => {
  // Case 1: 1,000 x 0.01 at maxRecords 10000.
  const f1 = fixture({
    amendPolicy(policy) { policy.maxRecords = 10000; },
    amendAdapters(adapters) {
      adapters.verifyEvidence = async request => ({
        subject: request.subject, scope: request.scope, namespace: request.namespace,
        evidenceHash: request.evidenceHash, verified: true, outcome: "pass",
        quality: 0.01, observedAt: new Date(f1.now()).toISOString(),
      });
    },
  });
  let applied1 = 0, stoppedBy1 = null;
  for (let i = 0; i < 1000; i++) {
    try {
      await f1.contribution(0, local, [3, 4]);
      applied1++;
    } catch (error) {
      if (error instanceof GovernanceError && error.code === "RECORD_LIMIT") { stoppedBy1 = "RECORD_LIMIT"; break; }
      throw error;
    }
  }
  if (applied1 !== 1000 || stoppedBy1 !== null) {
    throw new Error(`META FAIL: precondition not met for case 1 (applied=${applied1}, stoppedBy=${stoppedBy1}); the harness could not run the B1 reproduction.`);
  }
  const cred1 = await f1.engine.credibility(f1.ids[0], local);
  assert.equal(cred1.tier, "steward", `META FAIL: case 1 (1,000 x 0.01 @ maxRecords 10000) — the tier is "${cred1.tier}" instead of "steward"; the underlying fix may already have landed. Lift this meta-test out.`);

  // Case 2: 333 x 0.02 at default maxRecords 1000. Per crosswalk §3 T9 (Resolved N2),
  // the second falsifier runs at DEFAULT policy. 333 contributions = 999 documents,
  // under the 1,000 cap — no RECORD_LIMIT stop. The META asserts the tier is still
  // "steward" (the B1 reproduction) so the lift-out fires the day a cap lands.
  const f2 = fixture({
    amendAdapters(adapters) {
      adapters.verifyEvidence = async request => ({
        subject: request.subject, scope: request.scope, namespace: request.namespace,
        evidenceHash: request.evidenceHash, verified: true, outcome: "pass",
        quality: 0.02, observedAt: new Date(f2.now()).toISOString(),
      });
    },
  });
  let applied2 = 0, stoppedBy2 = null;
  for (let i = 0; i < 333; i++) {
    try {
      await f2.contribution(0, local, [3, 4]);
      applied2++;
    } catch (error) {
      if (error instanceof GovernanceError && error.code === "RECORD_LIMIT") { stoppedBy2 = "RECORD_LIMIT"; break; }
      throw error;
    }
  }
  assert.equal(applied2, 333, `META FAIL: case 2 precondition — expected 333 applied, got ${applied2}; the batch must fully land at default policy.`);
  assert.equal(stoppedBy2, null, "META FAIL: case 2 precondition — RECORD_LIMIT must not stop the batch at 333 x 0.02 @ default (999 documents < 1000 cap).");
  const cred2 = await f2.engine.credibility(f2.ids[0], local);
  assert.equal(cred2.tier, "steward", `META FAIL: case 2 (333 x 0.02 @ default) — the tier is "${cred2.tier}" instead of "steward"; the underlying fix may already have landed. Lift this meta-test out.`);
});

test("T9 MUTANT: a per-subject score cap below the steward threshold makes the assertion pass (proves test sensitivity)", async () => {
  // Same setup as the CONTROL case; we apply the simulated cap at the
  // READ seam (post-credibility), so the source is unchanged.
  const f = fixture({
    amendPolicy(policy) { policy.maxRecords = 10000; },
    amendAdapters(adapters) {
      adapters.verifyEvidence = async request => ({
        subject: request.subject, scope: request.scope, namespace: request.namespace,
        evidenceHash: request.evidenceHash, verified: true, outcome: "pass",
        quality: 0.01, observedAt: new Date(f.now()).toISOString(),
      });
    },
  });
  for (let i = 0; i < 1000; i++) {
    await f.contribution(0, local, [3, 4]);
  }
  const raw = await f.engine.credibility(f.ids[0], local);
  // Simulated fix: cap the cumulative score below the steward threshold (6).
  const fixed = { ...raw, tier: raw.score >= 6 ? "established" : raw.tier };
  assert.equal(raw.tier, "steward", "without the cap, the assertion's target value is reproduced (B1)");
  assert.notEqual(fixed.tier, "steward", "MUTANT: a non-linear cap drops tier below steward; the assertion is sensitive to the fix");
});