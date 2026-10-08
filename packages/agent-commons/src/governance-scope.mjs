/**
 * Classifies an operation into one of three tiers per L3 Section 6.1:
 * - Tier 1: Local peer messaging (offline, key-derived identities, no registry/principal checks)
 * - Tier 2: Default local profile evolution (offline, commons:evolve, produces advisory approval)
 * - Tier 3: Principal-governed institutional operations (strict opt-in, mandatory action-time verifier)
 */
export function classifyOperationTier(operation, options = {}) {
  const { scope, policy } = options;

  // Tier 1: Local peer messaging operations
  if (
    [
      "send",
      "receive",
      "receiveInternal",
      "flush",
      "flushInternal",
      "broadcast",
      "poll"
    ].includes(operation)
  ) {
    return "tier1-messaging";
  }

  // Tier 3: Explicit global scope, global policy mode, explicit principal-required mode, or standards items
  if (
    scope === "global" ||
    policy?.mode === "global" ||
    policy?.governanceMode === "principal-required" ||
    operation === "standards-work"
  ) {
    return "tier3-principal-governed";
  }

  // Tier 2: Local profile evolution under default mode
  if (["propose", "vote", "apply", "applyInternal"].includes(operation)) {
    return "tier2-default-local-evolution";
  }

  // Fail-closed default for unknown operations
  return "tier3-principal-governed";
}

/**
 * Enforces action-time principal mapping and status verification for Tier 3 governance actions.
 * Missing mapping fails with PRINCIPAL_MAPPING_REQUIRED.
 * Verifier failure or errors fail with STATUS_VERIFIER_UNAVAILABLE.
 * Superseded status fails with PRINCIPAL_SUPERSEDED.
 * Suspended/revoked/expired/not-found fail with PRINCIPAL_STATUS_DENIED.
 * Strict no-fallback rule: governed refusals never degrade to Tier 2 local evolution.
 */
export async function verifyPrincipalGovernance(uuaid, verifier, policy) {
  const principalId = policy?.principals?.[uuaid];
  if (!principalId) {
    const err = new Error(`Principal mapping required for ${uuaid}`);
    err.code = "PRINCIPAL_MAPPING_REQUIRED";
    throw err;
  }

  if (!verifier || typeof verifier.checkStatus !== "function") {
    const err = new Error("Status verifier unavailable: no verifier configured");
    err.code = "STATUS_VERIFIER_UNAVAILABLE";
    throw err;
  }

  let result;
  try {
    result = await verifier.checkStatus(principalId);
  } catch (cause) {
    const err = new Error(`Status verifier unavailable: ${cause.message}`);
    err.code = "STATUS_VERIFIER_UNAVAILABLE";
    err.cause = cause;
    throw err;
  }

  if (!result || typeof result !== "object" || !result.status) {
    const err = new Error("Status verifier returned invalid result");
    err.code = "STATUS_VERIFIER_UNAVAILABLE";
    throw err;
  }

  if (result.status === "superseded") {
    const err = new Error(`Principal ${principalId} is superseded`);
    err.code = "PRINCIPAL_SUPERSEDED";
    throw err;
  }

  if (result.status !== "active") {
    const err = new Error(`Principal ${principalId} status denied: ${result.status}`);
    err.code = "PRINCIPAL_STATUS_DENIED";
    err.status = result.status;
    throw err;
  }

  return {
    principalId,
    status: "active",
    checkedAt: result.checkedAt ?? Date.now()
  };
}

/**
 * In-memory test fixture implementing PrincipalStatusVerifier for offline tests.
 */
export class MockPrincipalStatusVerifier {
  #statuses = new Map();
  #errors = new Map();

  constructor(initialStatuses = {}) {
    if (initialStatuses instanceof Map) {
      for (const [k, v] of initialStatuses) {
        this.#statuses.set(k, v);
      }
    } else if (typeof initialStatuses === "object" && initialStatuses !== null) {
      for (const [k, v] of Object.entries(initialStatuses)) {
        this.#statuses.set(k, v);
      }
    }
  }

  setStatus(principalId, status) {
    this.#statuses.set(principalId, status);
  }

  setThrows(principalId, error) {
    this.#errors.set(principalId, error);
  }

  async checkStatus(principalId) {
    if (this.#errors.has(principalId)) {
      throw this.#errors.get(principalId);
    }
    const status = this.#statuses.get(principalId) ?? "not-found";
    return {
      status,
      checkedAt: Date.now()
    };
  }
}
