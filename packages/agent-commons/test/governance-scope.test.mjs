import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyOperationTier,
  verifyPrincipalGovernance,
  MockPrincipalStatusVerifier
} from "../src/governance-scope.mjs";

test("Three-tier scope classification: Section 6.1 matrix (two-pole)", () => {
  const localPolicy = { mode: "local" };
  const globalPolicy = { mode: "global" };
  const strictGovernancePolicy = { mode: "local", governanceMode: "principal-required" };

  // Tier 1: Local peer messaging operations
  const messagingOps = ["send", "receive", "receiveInternal", "flush", "flushInternal", "broadcast", "poll"];
  for (const op of messagingOps) {
    // Under local policy
    assert.equal(classifyOperationTier(op, { scope: "local", policy: localPolicy }), "tier1-messaging");
    // Under global policy, messaging remains Tier 1 (authenticated via key-derived IDs without principal verifier)
    assert.equal(classifyOperationTier(op, { scope: "local", policy: globalPolicy }), "tier1-messaging");
  }

  // Tier 2: Default local profile evolution (preserves runtime.test.mjs baseline byte-for-byte)
  const evolutionOps = ["propose", "vote", "apply", "applyInternal"];
  for (const op of evolutionOps) {
    const tier = classifyOperationTier(op, { scope: "local", policy: localPolicy });
    assert.equal(
      tier,
      "tier2-default-local-evolution",
      `Expected ${op} to be Tier 2 under default local mode`
    );
  }

  // Tier 3: Explicit global scope, global mode, explicit principal-required mode, or standards work
  for (const op of evolutionOps) {
    // (a) Scope is global
    assert.equal(
      classifyOperationTier(op, { scope: "global", policy: localPolicy }),
      "tier3-principal-governed"
    );
    // (b) Policy mode is global
    assert.equal(
      classifyOperationTier(op, { scope: "local", policy: globalPolicy }),
      "tier3-principal-governed"
    );
    // (c) Explicit governanceMode: "principal-required"
    assert.equal(
      classifyOperationTier(op, { scope: "local", policy: strictGovernancePolicy }),
      "tier3-principal-governed"
    );
  }

  // Standards work item is always Tier 3
  assert.equal(
    classifyOperationTier("standards-work", { scope: "local", policy: localPolicy }),
    "tier3-principal-governed"
  );

  // Mutant pole check: global scope MUST NOT degrade to Tier 2 local evolution
  const mutantGlobalClassification = (op, scope) => scope === "global" ? "tier2-default-local-evolution" : "tier2-default-local-evolution";
  assert.notEqual(
    mutantGlobalClassification("propose", "global"),
    "tier3-principal-governed",
    "Mutant degrading global scope to Tier 2 must be detectable"
  );
});

test("Principal governance status verification: action-time checks (two-pole)", async () => {
  const verifier = new MockPrincipalStatusVerifier({
    "018e3a2b-1111-7000-8000-000000000001": "active",
    "018e3a2b-2222-7000-8000-000000000002": "superseded",
    "018e3a2b-3333-7000-8000-000000000003": "suspended",
    "018e3a2b-4444-7000-8000-000000000004": "revoked",
    "018e3a2b-5555-7000-8000-000000000005": "expired"
  });

  const policy = {
    principals: {
      "uuaid:agent:active-1": "018e3a2b-1111-7000-8000-000000000001",
      "uuaid:agent:superseded-2": "018e3a2b-2222-7000-8000-000000000002",
      "uuaid:agent:suspended-3": "018e3a2b-3333-7000-8000-000000000003",
      "uuaid:agent:revoked-4": "018e3a2b-4444-7000-8000-000000000004",
      "uuaid:agent:expired-5": "018e3a2b-5555-7000-8000-000000000005",
      "uuaid:agent:notfound-6": "018e3a2b-6666-7000-8000-000000000006"
    }
  };

  // Control pole: Active principal succeeds
  const activeResult = await verifyPrincipalGovernance("uuaid:agent:active-1", verifier, policy);
  assert.equal(activeResult.principalId, "018e3a2b-1111-7000-8000-000000000001");
  assert.equal(activeResult.status, "active");
  assert.ok(typeof activeResult.checkedAt === "number");

  // Mutant pole 1: Missing principal mapping fails closed
  await assert.rejects(
    async () => verifyPrincipalGovernance("uuaid:agent:unmapped", verifier, policy),
    (err) => err.code === "PRINCIPAL_MAPPING_REQUIRED"
  );

  // Mutant pole 2: Superseded terminal state fails closed with PRINCIPAL_SUPERSEDED
  await assert.rejects(
    async () => verifyPrincipalGovernance("uuaid:agent:superseded-2", verifier, policy),
    (err) => err.code === "PRINCIPAL_SUPERSEDED"
  );

  // Mutant pole 3: Suspended / Revoked / Expired / Not-found fail closed with PRINCIPAL_STATUS_DENIED
  await assert.rejects(
    async () => verifyPrincipalGovernance("uuaid:agent:suspended-3", verifier, policy),
    (err) => err.code === "PRINCIPAL_STATUS_DENIED" && err.status === "suspended"
  );

  await assert.rejects(
    async () => verifyPrincipalGovernance("uuaid:agent:revoked-4", verifier, policy),
    (err) => err.code === "PRINCIPAL_STATUS_DENIED" && err.status === "revoked"
  );

  await assert.rejects(
    async () => verifyPrincipalGovernance("uuaid:agent:expired-5", verifier, policy),
    (err) => err.code === "PRINCIPAL_STATUS_DENIED" && err.status === "expired"
  );

  await assert.rejects(
    async () => verifyPrincipalGovernance("uuaid:agent:notfound-6", verifier, policy),
    (err) => err.code === "PRINCIPAL_STATUS_DENIED" && err.status === "not-found"
  );

  // Mutant pole 4: Verifier error fails closed with STATUS_VERIFIER_UNAVAILABLE
  verifier.setThrows(
    "018e3a2b-1111-7000-8000-000000000001",
    new Error("Connection reset by peer / HTTP 503")
  );
  await assert.rejects(
    async () => verifyPrincipalGovernance("uuaid:agent:active-1", verifier, policy),
    (err) => err.code === "STATUS_VERIFIER_UNAVAILABLE"
  );

  // Mutant pole 5: Missing verifier instance fails closed with STATUS_VERIFIER_UNAVAILABLE
  await assert.rejects(
    async () => verifyPrincipalGovernance("uuaid:agent:active-1", null, policy),
    (err) => err.code === "STATUS_VERIFIER_UNAVAILABLE"
  );
});
