import test from "node:test";
import assert from "node:assert/strict";
import { Keychain, jcs } from "../src/pillar.mjs";
import { signDocument, digest } from "../src/profiles.mjs";
import { PeerGovernance, GovernanceError, CLAIM_TYPES, ACTION_MANIFEST, createActionBudget, verifyGovernanceDocument } from "../src/governance.mjs";

const local = { scope: "local", namespace: "fleet/test" };
const global = { scope: "global", namespace: "fleet/test" };
const code = expected => error => error instanceof GovernanceError && error.code === expected;
function fixture({ amendKeys = () => {}, amendPolicy = () => {}, amendAdapters = () => {}, policy: overrides = {} } = {}) {
  let now = Date.now();
  const keys = Array.from({ length: 7 }, () => {
    const key = new Keychain("unused"); key._identity = Keychain.generate(); return key;
  });
  amendKeys(keys);
  const ids = keys.map(k => k._identity.uuaid), publicKeys = keys.map(k => k._identity.publicKeyHex);
  const capabilities = ["commons:observe", "commons:contribute", "commons:review-evidence", "commons:evolve", "commons:review"];
  const policy = {
    agents: Object.fromEntries(ids.map((id, i) => [id, {
      kind: "agent", publicKey: publicKeys[i], controllerId: `independent-controller-${i}`,
      affiliations: [], capabilities: [...capabilities], credentialId: `credential-${i}`,
      claims: Object.fromEntries(CLAIM_TYPES.map(type => [type, `${type}-${i}`])),
      name: "AAIU AIOU Zilligon Accredited Supreme Steward",
    }])),
    requiredGlobalClaims: [...CLAIM_TYPES], credentialIssuers: ["credential-authority"],
    claimIssuers: Object.fromEntries(CLAIM_TYPES.map(type => [type, [`${type}-authority`]])),
    ...overrides,
  };
  const blocked = new Set(), revoked = new Set(), badClaims = new Set(), withdrawn = new Set();
  const measurements = new Map(), calls = [];
  const current = () => ({ signatureValid: true, revoked: false, notExpired: true,
    checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString() });
  const adapters = {
    authorize: async request => ({ ...request, authorized: !blocked.has(request.subject) }),
    verifyCredential: async request => {
      calls.push({ adapter: "credential", ...request });
      return { ...request, ...current(), valid: true, issuer: "credential-authority", revoked: revoked.has(request.subject) };
    },
    verifyClaim: async request => {
      calls.push({ adapter: "claim", ...request });
      return { ...request, ...current(), verified: !badClaims.has(request.type), issuer: `${request.type}-authority` };
    },
    verifyEvidence: async request => ({
      subject: request.subject, scope: request.scope, namespace: request.namespace,
      evidenceHash: request.evidenceHash, verified: !withdrawn.has(request.evidenceHash),
      outcome: "pass", quality: 1, observedAt: measurements.get(request.evidenceHash) ?? new Date(now).toISOString(),
    }),
  };
  amendPolicy(policy, ids, publicKeys);
  amendAdapters(adapters, { current, ids, publicKeys, now: () => now });
  const engine = new PeerGovernance({ policy, adapters, clock: () => now });
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
        ...ctx, contributionId: result.id, evidenceHash, approve: true, rationale: "Reproduced held-out task results",
      }));
    }
    return { id: result.id, evidenceHash, document };
  }
  async function seed(i, count, ctx = local) {
    for (let n = 0; n < count; n++) await contribution(i, ctx);
  }
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
    policy, adapters, calls, blocked, revoked, badClaims, withdrawn, measurements,
    now: () => now, advance: ms => { now += ms; } };
}

test("signed governance documents verify key ownership, exact shape, size and tamper resistance", () => {
  const f = fixture();
  const doc = f.signed(0, "governance-contribution", { ...local, evidenceHash: digest("one") });
  assert.equal(verifyGovernanceDocument(doc).issuer, f.ids[0]);
  assert.throws(() => verifyGovernanceDocument({ ...doc, payload: { ...doc.payload, namespace: "other" } }), code("INVALID_SIGNATURE"));
  assert.throws(() => verifyGovernanceDocument({ ...doc, issuer: f.ids[1] }), code("INVALID_SIGNATURE"));
  assert.throws(() => verifyGovernanceDocument({ ...doc, id: "not-a-uuid" }), code("INVALID_DOCUMENT"));
  assert.throws(() => verifyGovernanceDocument({ ...doc, extra: true }), code("INVALID_DOCUMENT"));
  assert.throws(() => verifyGovernanceDocument({ ...doc, payload: { text: "x".repeat(32000) } }), code("INVALID_DOCUMENT"));
});

test("display names and badges confer no credibility or proposal rights", async () => {
  const f = fixture({ amendPolicy(policy, ids) {
    policy.agents[ids[0]].model = "top-ranked-model";
    policy.agents[ids[0]].provider = "trusted-looking-provider-label";
    policy.agents[ids[0]].badges = [...CLAIM_TYPES];
  } });
  const permission = await f.engine.permission(f.ids[0], f.publicKeys[0], "propose", local);
  assert.equal(permission.tier, "observer"); assert.equal(permission.allowed, false); assert.equal(permission.certified, false);
  await assert.rejects(f.engine.apply(f.proposal()), code("TIER_DENIED"));
});

test("credibility requires reproducible contribution evidence and two independent reviewers", async () => {
  const f = fixture();
  const contribution = await f.contribution(0, local, [3]);
  assert.equal((await f.engine.credibility(f.ids[0], local)).score, 0);
  await f.engine.apply(f.signed(4, "governance-evidence-review", {
    ...local, contributionId: contribution.id, evidenceHash: contribution.evidenceHash,
    approve: true, rationale: "Independent reproduction",
  }));
  const credibility = await f.engine.credibility(f.ids[0], local);
  assert.equal(credibility.score, 1); assert.equal(credibility.accepted, 1); assert.equal(credibility.tier, "contributor");
});

test("local/global and namespace credibility cannot be laundered into each other", async () => {
  const f = fixture(); await f.seed(0, 6);
  assert.equal((await f.engine.credibility(f.ids[0], local)).score, 6);
  assert.equal((await f.engine.credibility(f.ids[0], global)).score, 0);
  assert.equal((await f.engine.credibility(f.ids[0], { ...local, namespace: "other" })).score, 0);
  await assert.rejects(f.engine.apply(f.proposal(0, global)), code("TIER_DENIED"));
  await f.seed(0, 3, global);
  assert.equal((await f.engine.permission(f.ids[0], f.publicKeys[0], "propose", global)).allowed, true);
});

test("old evidence decays by half-life; adapter refresh never resets its age", async () => {
  const f = fixture(); const c = await f.contribution(0);
  f.advance(30 * 86400000);
  // The adapter tries to refresh observedAt; the original observation wins.
  f.measurements.set(c.evidenceHash, new Date(f.now()).toISOString());
  assert.equal((await f.engine.credibility(f.ids[0], local)).score, 0.5);
  assert.equal((await f.engine.permission(f.ids[0], f.publicKeys[0], "propose", local)).allowed, false);
  f.advance(61 * 86400000);
  // A continuously available adapter cannot resurrect long-expired evidence.
  f.measurements.delete(c.evidenceHash);
  assert.equal((await f.engine.credibility(f.ids[0], local)).score, 0);
});

test("evidence withdrawal and revoked reviewers remove previously earned credibility", async () => {
  const f = fixture(); const c = await f.contribution(0);
  f.revoked.add(f.ids[3]);
  assert.equal((await f.engine.credibility(f.ids[0], local)).score, 0);
  f.revoked.clear(); assert.equal((await f.engine.credibility(f.ids[0], local)).score, 1);
  f.withdrawn.add(c.evidenceHash);
  assert.equal((await f.engine.credibility(f.ids[0], local)).score, 0);
});

test("same artifact cannot produce duplicate contribution credit under another id or agent", async () => {
  const f = fixture(); const c = await f.contribution(0);
  assert.deepEqual(await f.engine.apply(c.document), { duplicate: true });
  for (const i of [0, 1]) {
    await assert.rejects(f.engine.apply(f.signed(i, "governance-contribution", {
      ...local, evidenceHash: c.evidenceHash,
    })), code("EVIDENCE_REPLAY"));
  }
  assert.equal((await f.engine.credibility(f.ids[0], local)).score, 1);
});

test("self-review and alternate identity controlled by the same principal are denied", async () => {
  const f = fixture({ amendPolicy(policy, ids) { policy.agents[ids[1]].controllerId = policy.agents[ids[0]].controllerId; } });
  const c = await f.contribution(0, local, []);
  for (const [i, expected] of [[0, "SELF_REVIEW"], [1, "REVIEWER_CONFLICT"]]) {
    await assert.rejects(f.engine.apply(f.signed(i, "governance-evidence-review", {
      ...local, contributionId: c.id, evidenceHash: c.evidenceHash, approve: true, rationale: "Conflicted",
    })), code(expected));
  }
});

test("shared affiliations and one-sided conflict declarations are enforced", async () => {
  for (const mode of ["affiliation", "conflict"]) {
    const f = fixture({ amendPolicy(policy, ids) {
      if (mode === "affiliation") { policy.agents[ids[0]].affiliations = ["owner"]; policy.agents[ids[3]].affiliations = ["owner"]; }
      else policy.agents[ids[3]].conflicts = [ids[0]];
    } });
    await assert.rejects(f.contribution(0, local, [3]), code("REVIEWER_CONFLICT"));
  }
});

test("reviewers must also be independent of each other; identities are not independent principals", async () => {
  const f = fixture({ amendPolicy(policy, ids) { policy.agents[ids[4]].controllerId = policy.agents[ids[3]].controllerId; } });
  await assert.rejects(f.contribution(0), code("REVIEWER_CONFLICT"));
  assert.equal((await f.engine.credibility(f.ids[0], local)).score, 0);
});

test("unknown controllers, unadmitted keys and missing capabilities fail closed", async () => {
  for (const mutate of [
    b => { delete b.controllerId; }, b => { b.publicKey = "a".repeat(64); },
    b => { b.capabilities = []; }, b => { b.kind = "human"; },
  ]) {
    const f = fixture({ amendPolicy(policy, ids) { mutate(policy.agents[ids[0]]); } });
    await assert.rejects(f.engine.permission(f.ids[0], f.publicKeys[0], "propose", local), error =>
      ["NOT_ADMITTED", "CAPABILITY_DENIED"].includes(error.code));
  }
});

test("tiered proposal and reviewer permissions are distinct from operator capability grants", async () => {
  const f = fixture();
  await f.seed(0, 1);
  assert.equal((await f.engine.permission(f.ids[0], f.publicKeys[0], "propose", local)).allowed, true);
  assert.equal((await f.engine.permission(f.ids[0], f.publicKeys[0], "review", local)).allowed, false);
  await f.seed(0, 2);
  assert.equal((await f.engine.permission(f.ids[0], f.publicKeys[0], "review", local)).allowed, true);
  await f.seed(0, 3, global);
  assert.equal((await f.engine.permission(f.ids[0], f.publicKeys[0], "propose", global)).allowed, true);
  assert.equal((await f.engine.permission(f.ids[0], f.publicKeys[0], "review", global)).allowed, false);
  await f.seed(0, 3, global);
  assert.equal((await f.engine.permission(f.ids[0], f.publicKeys[0], "review", global)).allowed, true);
  await assert.rejects(f.engine.permission(f.ids[0], f.publicKeys[0], "ratify-global", global), code("ACTION_FORBIDDEN"));
});

test("proposal votes deny self-voting, duplicate ballots and ineligible reviewers", async () => {
  const f = fixture(); await f.seed(0, 3); await f.seed(1, 3);
  const p = f.proposal(); await f.engine.apply(p);
  await assert.rejects(f.engine.apply(f.vote(0, p)), code("SELF_REVIEW"));
  await assert.rejects(f.engine.apply(f.vote(2, p)), code("TIER_DENIED"));
  await f.engine.apply(f.vote(1, p));
  await assert.rejects(f.engine.apply(f.vote(1, p)), code("DUPLICATE_REVIEW"));
  assert.equal((await f.engine.proposalStatus(p.id)).approvals, 1);
});

test("proposal votes reject separately credentialed reviewers under the author's controller", async () => {
  const f = fixture({ amendPolicy(policy, ids) { policy.agents[ids[1]].controllerId = policy.agents[ids[0]].controllerId; } });
  await f.seed(0, 1); await f.seed(1, 3);
  const p = f.proposal(); await f.engine.apply(p);
  await assert.rejects(f.engine.apply(f.vote(1, p)), code("REVIEWER_CONFLICT"));
  assert.equal((await f.engine.proposalStatus(p.id)).approvals, 0);
});

test("proposal quorum rejects distinct reviewer keys sharing one controller", async () => {
  const f = fixture({ amendPolicy(policy, ids) { policy.agents[ids[2]].controllerId = policy.agents[ids[1]].controllerId; } });
  await f.seed(0, 1); await f.seed(1, 3); await f.seed(2, 3);
  const p = f.proposal(); await f.engine.apply(p);
  await f.engine.apply(f.vote(1, p));
  await assert.rejects(f.engine.apply(f.vote(2, p)), code("REVIEWER_CONFLICT"));
  assert.equal((await f.engine.proposalStatus(p.id)).approvals, 1);
});

test("a shared signing key under another valid UUAID realm is not an independent proposal reviewer", async () => {
  const f = fixture({ amendKeys(keys) {
    keys[1]._identity = { ...keys[0]._identity, uuaid: keys[0]._identity.uuaid.replace(":foundation:", ":other:") };
  } });
  assert.notEqual(f.ids[0], f.ids[1]); assert.equal(f.publicKeys[0], f.publicKeys[1]);
  await f.seed(0, 1); await f.seed(1, 3);
  const p = f.proposal(); await f.engine.apply(p);
  await assert.rejects(f.engine.apply(f.vote(1, p)), code("REVIEWER_CONFLICT"));
});

test("seven bootstrap keys controlled by local-operator cannot bootstrap independent credibility", async () => {
  const f = fixture({ amendPolicy(policy, ids) {
    ids.forEach(id => { policy.agents[id].controllerId = "local-operator"; });
  } });
  await assert.rejects(f.contribution(0), code("REVIEWER_CONFLICT"));
  for (const id of f.ids) assert.equal((await f.engine.credibility(id, local)).score, 0);
  await assert.rejects(f.engine.apply(f.proposal()), code("TIER_DENIED"));
});

test("parallel independent votes yield reversible local advisory approval, not execution", async () => {
  const f = fixture(); await f.seed(0, 1); await f.seed(1, 3); await f.seed(2, 3);
  const p = f.proposal(); await f.engine.apply(p);
  const results = await Promise.all([f.engine.apply(f.vote(1, p)), f.engine.apply(f.vote(2, p))]);
  assert.equal(results.at(-1).status, "local-peer-approved");
  assert.equal(results.at(-1).ratified, false); assert.equal(results.at(-1).executionAllowed, false);
  assert.equal(results.at(-1).rollbackHash, p.payload.parentHash);
  f.revoked.add(f.ids[1]);
  assert.equal((await f.engine.proposalStatus(p.id)).status, "pending");
});

test("a valid dissenting reviewer vetoes advisory approval", async () => {
  const f = fixture(); await f.seed(0, 1); await f.seed(1, 3); await f.seed(2, 3);
  const p = f.proposal(); await f.engine.apply(p);
  await f.engine.apply(f.vote(1, p, false));
  const status = await f.engine.apply(f.vote(2, p));
  assert.equal(status.veto, true); assert.equal(status.status, "pending");
});

test("global quorum only queues independent authority review and never ratifies", async () => {
  const f = fixture(); await f.seed(0, 3, global); await f.seed(1, 6, global); await f.seed(2, 6, global);
  const p = f.proposal(0, global); await f.engine.apply(p);
  await f.engine.apply(f.vote(1, p)); const result = await f.engine.apply(f.vote(2, p));
  assert.equal(result.status, "awaiting-independent-authority");
  assert.equal(result.ratified, false); assert.equal(result.executionAllowed, false);
});

test("revoked author and withdrawn proposal measurements prevent new votes", async () => {
  const f = fixture(); await f.seed(0, 1); await f.seed(1, 3);
  const p = f.proposal(); await f.engine.apply(p);
  f.revoked.add(f.ids[0]);
  await assert.rejects(f.engine.apply(f.vote(1, p)), code("CREDENTIAL_INVALID"));
  f.revoked.clear(); f.withdrawn.add(p.payload.evidenceHash);
  await assert.rejects(f.engine.apply(f.vote(1, p)), code("EVIDENCE_INVALID"));
  f.withdrawn.clear(); assert.equal((await f.engine.proposalStatus(p.id)).approvals, 0);
  await f.engine.apply(f.vote(1, p));
});

test("credentials require exact subject/key/id, allowed issuer, signature, revocation and fresh expiry evidence", async () => {
  const mutations = [
    v => ({ ...v, valid: false }), v => ({ ...v, signatureValid: false }), v => ({ ...v, revoked: true }),
    v => ({ ...v, notExpired: false }), v => ({ ...v, subject: "someone-else" }),
    v => ({ ...v, publicKey: "a".repeat(64) }), v => ({ ...v, credentialId: "wrong" }),
    v => ({ ...v, scope: "local" }), v => ({ ...v, namespace: "other" }),
    v => ({ ...v, issuer: "untrusted" }), v => ({ ...v, revoked: undefined }),
    v => ({ ...v, expiresAt: "invalid" }), v => ({ ...v, checkedAt: "2000-01-01T00:00:00Z" }),
  ];
  for (const mutate of mutations) {
    const f = fixture({ amendAdapters(adapters) {
      const verify = adapters.verifyCredential; adapters.verifyCredential = async request => mutate(await verify(request));
    } });
    await assert.rejects(f.engine.permission(f.ids[0], f.publicKeys[0], "observe", global), code("CREDENTIAL_INVALID"));
  }
});

test("credentials expiring exactly now or checked in the future are invalid", async () => {
  for (const field of ["expiresAt", "checkedAt"]) {
    const f = fixture({ amendAdapters(adapters, clock) {
      const verify = adapters.verifyCredential;
      adapters.verifyCredential = async request => ({ ...await verify(request),
        [field]: new Date(clock.now() + (field === "checkedAt" ? 1 : 0)).toISOString() });
    } });
    await assert.rejects(f.engine.permission(f.ids[0], f.publicKeys[0], "observe", global), code("CREDENTIAL_INVALID"));
  }
});

test("AAIU, AIOU and Zilligon claims are checked individually through the injected adapter", async () => {
  const f = fixture();
  const claims = await f.engine.checkClaims(f.ids[0], f.publicKeys[0], global);
  assert.deepEqual(claims.map(c => c.type), CLAIM_TYPES);
  assert.deepEqual(f.calls.filter(c => c.adapter === "claim").map(c => c.type), CLAIM_TYPES);
  for (const type of CLAIM_TYPES) {
    f.badClaims.add(type);
    await assert.rejects(f.engine.permission(f.ids[0], f.publicKeys[0], "observe", global), code("CLAIM_UNVERIFIED"));
    f.badClaims.clear();
  }
});

test("claim badges without pinned ids or issuers are not verification", async () => {
  for (const mode of ["missing-id", "missing-issuer"]) {
    const f = fixture({ amendPolicy(policy, ids) {
      if (mode === "missing-id") delete policy.agents[ids[0]].claims.AAIU;
      else policy.claimIssuers.AAIU = [];
    } });
    await assert.rejects(f.engine.checkClaims(f.ids[0], f.publicKeys[0], global), code("CLAIM_UNVERIFIED"));
  }
});

test("claims reject cross-context, spoofed subject, revoked, expired and untrusted issuer results", async () => {
  for (const mutate of [
    v => ({ ...v, scope: "local" }), v => ({ ...v, namespace: "another" }),
    v => ({ ...v, subject: "another" }), v => ({ ...v, type: "Other" }),
    v => ({ ...v, claimId: "other" }), v => ({ ...v, issuer: "other" }),
    v => ({ ...v, signatureValid: false }), v => ({ ...v, revoked: true }),
    v => ({ ...v, expiresAt: "2000-01-01T00:00:00Z" }),
  ]) {
    const f = fixture({ amendAdapters(adapters) {
      const verify = adapters.verifyClaim; adapters.verifyClaim = async request => mutate(await verify(request));
    } });
    await assert.rejects(f.engine.checkClaims(f.ids[0], f.publicKeys[0], global), code("CLAIM_UNVERIFIED"));
  }
});

test("missing and failing authority adapters fail closed without imaginary APIs", async () => {
  for (const name of ["authorize", "verifyCredential", "verifyClaim"]) {
    for (const mode of ["missing", "throws"]) {
      const f = fixture({ amendAdapters(adapters) {
        if (mode === "missing") delete adapters[name]; else adapters[name] = async () => { throw new Error("offline"); };
      } });
      await assert.rejects(f.engine.permission(f.ids[0], f.publicKeys[0], "observe", global), code("VERIFIER_UNAVAILABLE"));
    }
  }
  const f = fixture({ amendAdapters(adapters) { delete adapters.verifyEvidence; } });
  await assert.rejects(f.contribution(0, local, []), code("VERIFIER_UNAVAILABLE"));
});

test("evidence verifier must bind digest, subject, scope, namespace and bounded positive results", async () => {
  for (const mutate of [
    v => ({ ...v, verified: false }), v => ({ ...v, subject: "another" }),
    v => ({ ...v, evidenceHash: digest("other") }), v => ({ ...v, scope: "global" }),
    v => ({ ...v, namespace: "other" }), v => ({ ...v, quality: 2 }),
    v => ({ ...v, quality: 0 }), v => ({ ...v, outcome: "fail" }),
    v => ({ ...v, observedAt: "invalid" }), v => ({ ...v, observedAt: "2000-01-01T00:00:00Z" }),
  ]) {
    const f = fixture({ amendAdapters(adapters) {
      const verify = adapters.verifyEvidence; adapters.verifyEvidence = async request => mutate(await verify(request));
    } });
    await assert.rejects(f.contribution(0, local, []), code("EVIDENCE_INVALID"));
    assert.equal((await f.engine.credibility(f.ids[0], local)).score, 0);
  }
});

test("code patches, security-policy changes and absent rollback are not proposal capabilities", async () => {
  const f = fixture(); await f.seed(0, 1);
  for (const extra of [
    { change: "self-modify" }, { patch: "arbitrary executable" }, { quorum: 1 }, { signingAlgorithm: "none" },
    { rollbackHash: digest("wrong") }, { candidateHash: digest("parent") }, { phrase: "~0~" },
  ]) {
    await assert.rejects(f.engine.apply(f.proposal(0, local, extra)), code("UNSAFE_PROPOSAL"));
  }
});

test("cross-context votes and reviews of different evidence are rejected", async () => {
  const f = fixture(); await f.seed(0, 1); await f.seed(1, 3);
  const p = f.proposal(); await f.engine.apply(p);
  await assert.rejects(f.engine.apply(f.vote(1, p, true, { namespace: "other" })), code("UNKNOWN_PROPOSAL"));
  await assert.rejects(f.engine.apply(f.vote(1, p, true, { evidenceHash: digest("unrelated") })), code("INVALID_REVIEW"));
  const c = await f.contribution(2, local, []);
  await assert.rejects(f.engine.apply(f.signed(3, "governance-evidence-review", {
    ...global, contributionId: c.id, evidenceHash: c.evidenceHash, approve: true, rationale: "Review",
  })), code("UNKNOWN_CONTRIBUTION"));
});

test("queued documents and policy are immutable snapshots; returned scores cannot mutate state", async () => {
  const f = fixture(); const c = await f.contribution(0);
  const score = await f.engine.credibility(f.ids[0], local);
  score.evidence[0].weight = 100;
  f.policy.agents[f.ids[0]].capabilities = [];
  assert.equal((await f.engine.credibility(f.ids[0], local)).score, 1);
  const doc = f.signed(3, "governance-evidence-review", {
    ...local, contributionId: c.id, evidenceHash: c.evidenceHash, approve: true, rationale: "Duplicate reviewer",
  });
  const pending = f.engine.apply(doc); doc.payload.contributionId = "modified";
  await assert.rejects(pending, code("DUPLICATE_REVIEW"));
});

test("bounded record count, stale inputs and unknown context fail closed", async () => {
  const f = fixture({ policy: { maxRecords: 1 } });
  await f.contribution(0, local, []);
  await assert.rejects(f.contribution(1, local, []), code("RECORD_LIMIT"));
  const fresh = fixture(); const doc = fresh.signed(0, "governance-contribution", { ...local, evidenceHash: digest("stale") });
  fresh.advance(86400001);
  await assert.rejects(fresh.engine.apply(doc), code("STALE_DOCUMENT"));
  await assert.rejects(fresh.engine.credibility(fresh.ids[0], { scope: "globla", namespace: "test" }), code("INVALID_CONTEXT"));
  assert.throws(() => new PeerGovernance({ policy: { quorum: 1 } }), code("INVALID_POLICY"));
});

test("dissenting evidence reviewers veto contribution credit until their authority is revoked", async () => {
  const f = fixture(); const c = await f.contribution(0);
  await f.engine.apply(f.signed(5, "governance-evidence-review", {
    ...local, contributionId: c.id, evidenceHash: c.evidenceHash,
    approve: false, rationale: "Failed independent reproduction",
  }));
  assert.equal((await f.engine.credibility(f.ids[0], local)).score, 0);
  f.revoked.add(f.ids[5]);
  assert.equal((await f.engine.credibility(f.ids[0], local)).score, 1);
});

test("global admission requires a credential even when no named claims are configured", async () => {
  const f = fixture({ policy: { requiredGlobalClaims: [] }, amendPolicy(policy, ids) {
    delete policy.agents[ids[0]].credentialId;
  } });
  await assert.rejects(f.engine.permission(f.ids[0], f.publicKeys[0], "observe", global), code("CREDENTIAL_REQUIRED"));
  assert.equal((await f.engine.permission(f.ids[0], f.publicKeys[0], "observe", local)).allowed, true);
});

test("an authorization adapter must bind subject, key, capability and context explicitly", async () => {
  for (const mutate of [
    v => ({ ...v, subject: "someone" }), v => ({ ...v, publicKey: "a".repeat(64) }),
    v => ({ ...v, capability: "commons:evolve" }), v => ({ ...v, scope: "global" }),
    v => ({ ...v, namespace: "other" }), () => ({ authorized: true }),
  ]) {
    const f = fixture({ amendAdapters(adapters) {
      const authorize = adapters.authorize; adapters.authorize = async request => mutate(await authorize(request));
    } });
    await assert.rejects(f.engine.permission(f.ids[0], f.publicKeys[0], "observe", local), code("AUTHORIZATION_DENIED"));
  }
});

test("unknown contribution fields and unrecognized claim types are refused", async () => {
  const f = fixture();
  await assert.rejects(f.engine.apply(f.signed(0, "governance-contribution", {
    ...local, evidenceHash: digest("unrecognized-fields"), certified: true,
  })), code("INVALID_PAYLOAD"));
  await assert.rejects(f.engine.checkClaims(f.ids[0], f.publicKeys[0], global, ["Imaginary"]), code("UNKNOWN_CLAIM"));
});

test("action manifest and per-run budget deny execution, ratification, self-modification and scope escalation", () => {
  let now = 1000;
  const budget = createActionBudget({ scope: "local", maxCalls: 2, maxBytes: 1000, durationMs: 100, clock: () => now });
  assert.equal(Object.isFrozen(ACTION_MANIFEST.actions.inspect), true);
  assert.equal(ACTION_MANIFEST.selfModification, false);
  assert.equal(budget.consume({ action: "inspect", scope: "local", payload: {} }).executionAllowed, false);
  for (const action of ["ratify-global", "self-modify", "execute", "constructor"]) {
    assert.throws(() => budget.consume({ action, scope: "local", payload: {} }), code("ACTION_FORBIDDEN"));
  }
  assert.throws(() => budget.consume({ action: "inspect", scope: "global", payload: {} }), code("ACTION_FORBIDDEN"));
  assert.throws(() => budget.consume({ action: "inspect", scope: "local", payload: {}, execute: true }), code("INVALID_ACTION"));
  budget.consume({ action: "inspect", scope: "local", payload: {} });
  assert.throws(() => budget.consume({ action: "inspect", scope: "local", payload: {} }), code("BUDGET_EXCEEDED"));
  now += 100;
  assert.throws(() => budget.consume({ action: "inspect", scope: "local", payload: {} }), code("BUDGET_EXPIRED"));
});

test("action budgets enforce cumulative bytes, canonical JSON, ceilings and monotonic time", () => {
  let now = 100;
  const budget = createActionBudget({ maxBytes: 100, clock: () => now });
  assert.throws(() => budget.consume({ action: "inspect", scope: "local", payload: { data: "x".repeat(100) } }), code("BUDGET_EXCEEDED"));
  assert.throws(() => budget.consume({ action: "inspect", scope: "local", payload: () => {} }), code("INVALID_ACTION"));
  assert.equal(budget.status().calls, 0);
  now--;
  assert.throws(() => budget.consume({ action: "inspect", scope: "local", payload: {} }), code("INVALID_CLOCK"));
  for (const options of [{ maxCalls: 101 }, { maxBytes: 32001 }, { durationMs: 3600001 }, { maxCalls: 0 }]) {
    assert.throws(() => createActionBudget(options), code("INVALID_BUDGET"));
  }
});
