// Designed against IAASO-3001..3801 (content_hash 22cb66b62affc70a87c21a5f387bc6f6d764a6d1275ce349e585eb8bf485257f); not assessed; not ratified.
//
// EXPECTED-RED controls for `packages/agent-commons/src/governance.mjs` —
// the runtime assertions that document the two known-vulnerable states:
//   T4  No Silent Denial (M1): every GovernanceError must carry a non-empty
//       `appeal_path`; today the class carries `.code` only, so this file
//       fails.
//   T9  Volume Is Not Authority (B1): 1,000 x 0.01 contributions at
//       maxRecords 10000 must NOT reach tier "steward"; the linear sum at
//       governance.mjs:207-228 makes tier = "steward" today, so this file
//       fails.
//
// These two tests are kept OUT of the main `npm test` suite so the package
// baseline stays green (per the suite-shape decision at
// the project design §3). The canary META tests
// that assert the failure state live in `test/governance-t1-t10.test.mjs`
// and are green today; they flip red the day a fix lands, at which point
// the raw controls here become the GREEN spec tests and the metas are
// lifted out. Until then: `npm run test:expected-red` is the documented-red
// surface (run it to see the bug reproduced).
//
// Do NOT weaken these tests to make them pass. Never. The failure IS the
// measurement.
//
// Suite outcome today (run from packages/agent-commons/):
//   $ npm run test:expected-red
//   1..2 / pass 0 / fail 2 / todo 0 / cancelled 0
// Both failures carry the documented reason in the assertion message.

import test from "node:test";
import assert from "node:assert/strict";
import { PeerGovernance, GovernanceError, CLAIM_TYPES } from "../src/governance.mjs";
import { Keychain, jcs } from "../src/pillar.mjs";
import { signDocument, digest } from "../src/profiles.mjs";

const local = { scope: "local", namespace: "fleet/l8-expected-red" };
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
  return { engine, ids, publicKeys, keys, signed, contribution, policy: policyObj, adapters, calls, blocked, revoked, badClaims, withdrawn, measurements, now: () => now, advance: ms => { now += ms; } };
}

function captureRefusal(f, kind, payload) {
  return f.engine.apply(f.signed(0, kind, payload))
    .then(() => { throw new Error("expected refusal"); }, error => error);
}

// ---------- T4: No Silent Denial (EXPECTED RED) ----------
//
// Every refusal of admission, review, proposal, or eligibility MUST carry
// both a refusal reason code AND an appeal_path. governance.mjs today
// raises GovernanceError with `.code` only; no `.appeal_path` exists.
// EXPECTED RED: this assertion MUST FAIL until appeal_path lands.
// NEVER weaken the assertion to make it pass.
//
// CONTROL (rc 1 today, GREEN after fix): every GovernanceError carries a
// non-empty `appeal_path` string.

test("T4 CONTROL: every GovernanceError carries a non-empty appeal_path (EXPECTED RED; fails today until appeal_path is implemented)", async () => {
  // MEASURED code on this fixture: SELF_REVIEW.
  // Setup: agent 0 authors the contribution; agent 3 reviews once. The
  // test then builds a second review signed by agent 3 and hands it to
  // `captureRefusal`, which RE-SIGNS the payload as agent 0
  // (`f.signed(0, kind, payload)` at line ~106 of this file). The engine
  // receives a review from agent 0 against a contribution also from
  // agent 0. `#apply` (governance.mjs:281) calls `#reviewEligibility`
  // (:319), which calls `#independent(0, 0)` and fires the SELF_REVIEW
  // guard at governance.mjs:176:
  //     if (a === b) fail("SELF_REVIEW")
  // That is the path the fixture takes; SELF_REVIEW fires before any
  // duplicate-review check (DUPLICATE_REVIEW at governance.mjs:320 is
  // only reached if the subject differs). The assertion is on the SHAPE
  // of the error (GovernanceError + missing appeal_path), not on a
  // specific code — the spec's rule is that every refusal carries an
  // appeal_path, whatever the refusal's reason. If a future change makes
  // the second review go to a different subject (so SELF_REVIEW stops
  // firing), the test would then surface DUPLICATE_REVIEW instead; the
  // assertion still holds because the contract is on appeal_path, not code.
  const f = fixture();
  const c = await f.contribution(0, local, [3]); // agent 3 has already reviewed
  const dup = f.signed(3, "governance-evidence-review", {
    ...local, contributionId: c.id, evidenceHash: c.evidenceHash,
    approve: false, rationale: "Self-review probe for T4 (captureRefusal re-signs as agent 0)",
  });
  const refusal = await captureRefusal(f, "governance-evidence-review", dup.payload);
  assert.ok(refusal instanceof GovernanceError, "must be a GovernanceError");
  // The code today is SELF_REVIEW (governance.mjs:176). If a future
  // change renames or splits that code, the assertion on appeal_path still
  // holds — the refusal's reason code is not the contract being tested.
  assert.equal(typeof refusal.appeal_path, "string", "appeal_path must be a non-empty string");
  assert.ok(refusal.appeal_path.length > 0, "appeal_path must be non-empty");
});

// ---------- T9: Volume Is Not Authority (EXPECTED RED; BLOCKER B1) ----------
//
// Both cases per crosswalk rev 6 §3 T9 (as corrected by Iaaso-Lead N1/N2):
//   (1) 1,000 low-quality contributions (quality 0.01) at maxRecords: 10000
//       must NOT reach tier "steward".
//   (2) 333 low-quality contributions (quality 0.02) at DEFAULT policy
//       (maxRecords: 1000) must NOT reach tier "steward". The precondition
//       is `applied === 333 && stoppedBy === null` (999 documents for 333
//       contributions, under the 1,000 cap).
// The spec mandates a precondition that every requested contribution
// actually applied; if the batch did not fully land, the test ERRORS,
// never passes.
//
// EXPECTED RED: both assertions MUST FAIL until a non-linear scoring curve
// and a per-controller cap land. NEVER weaken the assertion to make it
// pass.
//
// CONTROL (rc 1 today, GREEN after fix): 1,000 x 0.01 at maxRecords 10000
// leaves tier != "steward"; 333 x 0.02 at default leaves tier != "steward".

test("T9 CONTROL (case 1): 1,000 x 0.01 at maxRecords 10000 must not reach steward (EXPECTED RED; fails today until non-linear cap lands)", async () => {
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
  let applied = 0, stoppedBy = null;
  for (let i = 0; i < 1000; i++) {
    try {
      await f.contribution(0, local, [3, 4]);
      applied++;
    } catch (error) {
      if (error instanceof GovernanceError && error.code === "RECORD_LIMIT") { stoppedBy = "RECORD_LIMIT"; break; }
      throw error;
    }
  }
  // PRECONDITION: the test must ERROR, never pass, if the batch did not
  // fully land. Per crosswalk §3 T9 (Resolved N1).
  assert.equal(applied, 1000, "precondition: all 1000 contributions must apply; RECORD_LIMIT would invalidate the test");
  assert.equal(stoppedBy, null, "precondition: no RECORD_LIMIT stop");
  // The spec-mandated assertion: tier != steward once the batch lands.
  const cred = await f.engine.credibility(f.ids[0], local);
  assert.notEqual(cred.tier, "steward",
    `EXPECTED RED: 1,000 x 0.01 must not reach steward; got tier=${cred.tier}, score=${cred.score}, accepted=${cred.accepted}. ` +
    `This is B1 (volume buys authority today; see the project design).`);
});

test("T9 CONTROL (case 2): 333 x 0.02 at DEFAULT policy (maxRecords 1000) must not reach steward (EXPECTED RED; fails today until non-linear cap lands)", async () => {
  // 333 contributions at quality 0.02 = 999 documents in the ledger (under
  // the default maxRecords: 1000). All 333 land with no RECORD_LIMIT stop;
  // the precondition `applied === 333 && stoppedBy === null` is asserted
  // first. The tier assertion fails today because 333 × 0.02 = 6.66 >= 6,
  // which is the "steward" threshold (governance.mjs:227).
  const f = fixture({
    amendAdapters(adapters) {
      adapters.verifyEvidence = async request => ({
        subject: request.subject, scope: request.scope, namespace: request.namespace,
        evidenceHash: request.evidenceHash, verified: true, outcome: "pass",
        quality: 0.02, observedAt: new Date(f.now()).toISOString(),
      });
    },
  });
  let applied = 0, stoppedBy = null;
  for (let i = 0; i < 333; i++) {
    try {
      await f.contribution(0, local, [3, 4]);
      applied++;
    } catch (error) {
      if (error instanceof GovernanceError && error.code === "RECORD_LIMIT") { stoppedBy = "RECORD_LIMIT"; break; }
      throw error;
    }
  }
  // PRECONDITION: 333 contributions = 999 documents, under the 1,000 cap.
  // Per crosswalk §3 T9 (Resolved N2): the batch must fully land.
  assert.equal(applied, 333, "precondition: all 333 contributions must apply; RECORD_LIMIT would invalidate the test");
  assert.equal(stoppedBy, null, "precondition: no RECORD_LIMIT stop");
  // The spec-mandated assertion: tier != steward once the batch lands.
  const cred = await f.engine.credibility(f.ids[0], local);
  assert.notEqual(cred.tier, "steward",
    `EXPECTED RED: 333 x 0.02 at default maxRecords must not reach steward; got tier=${cred.tier}, score=${cred.score}, accepted=${cred.accepted}. ` +
    `This is B1 (volume buys authority today; see the project design).`);
});
