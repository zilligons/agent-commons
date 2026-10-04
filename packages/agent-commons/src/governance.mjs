import { assertJSON, BASE_PROTOCOL, digest } from "./profiles.mjs";
import { jcs, Keychain } from "./pillar.mjs";

// This module deliberately performs no network calls and executes no changes.
// Operators must inject verifiers backed by actual identity/evidence authorities.
export class GovernanceError extends Error {
  constructor(code, message = code) { super(message); this.name = "GovernanceError"; this.code = code; }
}
const fail = (code, message) => { throw new GovernanceError(code, message); };
const text = value => typeof value === "string" && value.length > 0 && value.length <= 256;
const hash = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const timestamp = value => typeof value === "string" ? Date.parse(value) : NaN;
const clone = value => structuredClone(value);
const DOCUMENT_KINDS = ["governance-contribution", "governance-evidence-review", "governance-proposal", "governance-vote"];
export function verifyGovernanceDocument(document) {
  assertJSON(document);
  if (!document || Object.keys(document).some(k => !["v", "id", "kind", "issuer", "publicKey", "createdAt", "payload", "signature"].includes(k)) ||
      Buffer.byteLength(JSON.stringify(document)) > ACTION_MANIFEST.ceilings.bytes) fail("INVALID_DOCUMENT");
  const { signature, ...body } = document;
  if (body.v !== BASE_PROTOCOL || !DOCUMENT_KINDS.includes(body.kind) ||
      typeof body.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.id) ||
      typeof body.issuer !== "string" || !/^uuaid:[a-z0-9-]+:agent:[0-9a-f-]{36}$/.test(body.issuer) ||
      !hash(body.publicKey) || typeof signature !== "string" || !/^[0-9a-f]{128}$/.test(signature)) fail("INVALID_DOCUMENT");
  if (Keychain.localIdFromKey(Buffer.from(body.publicKey, "hex")) !== body.issuer.split(":")[3] ||
      !Keychain.verifyDetached(body.publicKey, Buffer.from(jcs(body)), Buffer.from(signature, "hex"))) fail("INVALID_SIGNATURE");
  return body;
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export const CLAIM_TYPES = freeze(["AAIU", "AIOU", "Zilligon"]);
export const ACTION_MANIFEST = freeze({
  version: 1,
  actions: {
    "inspect": { scopes: ["local", "global"], permission: "observe" },
    "submit-evidence": { scopes: ["local", "global"], permission: "contribute" },
    "review-evidence": { scopes: ["local", "global"], permission: "review-evidence" },
    "propose-alias": { scopes: ["local", "global"], permission: "propose" },
    "review-proposal": { scopes: ["local", "global"], permission: "review" },
  },
  ceilings: { calls: 100, bytes: 32000, durationMs: 3600000 },
  execution: "advisory-only",
  globalRatification: false,
  selfModification: false,
});

/** A one-run guard, not a scheduler or an execution capability. */
export function createActionBudget({ scope = "local", maxCalls = 16, maxBytes = 8000, durationMs = 60000, clock = Date.now } = {}) {
  context({ scope, namespace: "budget" });
  const ceilings = ACTION_MANIFEST.ceilings;
  for (const [value, ceiling] of [[maxCalls, ceilings.calls], [maxBytes, ceilings.bytes], [durationMs, ceilings.durationMs]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) fail("INVALID_BUDGET");
  }
  if (typeof clock !== "function") fail("INVALID_CLOCK");
  const start = clock();
  if (!Number.isSafeInteger(start)) fail("INVALID_CLOCK");
  let calls = 0, bytes = 0, last = start;
  return freeze({
    consume(request) {
      const now = clock();
      if (!Number.isSafeInteger(now) || now < last) fail("INVALID_CLOCK");
      last = now;
      if (now - start >= durationMs) fail("BUDGET_EXPIRED");
      if (!request || Object.keys(request).some(k => !["action", "scope", "payload"].includes(k))) fail("INVALID_ACTION");
      const definition = Object.hasOwn(ACTION_MANIFEST.actions, request.action) && ACTION_MANIFEST.actions[request.action];
      if (!definition || request.scope !== scope || !definition.scopes.includes(scope)) fail("ACTION_FORBIDDEN");
      let encoded;
      try { assertJSON(request); encoded = JSON.stringify(request); } catch { fail("INVALID_ACTION"); }
      const size = Buffer.byteLength(encoded);
      if (calls + 1 > maxCalls || bytes + size > maxBytes) fail("BUDGET_EXCEEDED");
      calls++; bytes += size;
      return { calls, bytes, permission: definition.permission, executionAllowed: false };
    },
    status() { return { calls, bytes, maxCalls, maxBytes, scope, executionAllowed: false }; },
  });
}

function context(value) {
  if (!value || !["local", "global"].includes(value.scope) || !text(value.namespace)) fail("INVALID_CONTEXT");
  return { scope: value.scope, namespace: value.namespace };
}
const sameContext = (a, b) => a.scope === b.scope && a.namespace === b.namespace;
const defaults = {
  halfLifeMs: 30 * 86400000, freshnessMs: 300000, documentMaxAgeMs: 86400000,
  evidenceMaxAgeMs: 90 * 86400000, quorum: 2, maxRecords: 1000,
  requiredGlobalClaims: [], agents: {}, claimIssuers: {}, credentialIssuers: [],
};

/**
 * Signed, bounded, in-memory oversight. All data is advisory: even a locally
 * approved proposal is never installed here. Persist signed inputs externally.
 */
export class PeerGovernance {
  #policy; #adapters; #clock; #contributions = new Map(); #proposals = new Map();
  #documents = new Map(); #tail = Promise.resolve(); #lastNow = -Infinity;
  constructor({ policy = {}, adapters = {}, clock = Date.now } = {}) {
    this.#policy = freeze(clone({ ...defaults, ...policy }));
    this.#adapters = { ...adapters };
    this.#clock = clock;
    for (const key of ["halfLifeMs", "freshnessMs", "documentMaxAgeMs", "evidenceMaxAgeMs", "maxRecords"]) {
      if (!Number.isSafeInteger(this.#policy[key]) || this.#policy[key] < 1) fail("INVALID_POLICY");
    }
    if (!Number.isSafeInteger(this.#policy.quorum) || this.#policy.quorum < 2 || this.#policy.quorum > 32 ||
        this.#policy.maxRecords > 10000 || !Array.isArray(this.#policy.requiredGlobalClaims) ||
        this.#policy.requiredGlobalClaims.some(type => !CLAIM_TYPES.includes(type)) ||
        new Set(this.#policy.requiredGlobalClaims).size !== this.#policy.requiredGlobalClaims.length ||
        !Array.isArray(this.#policy.credentialIssuers) || typeof clock !== "function") fail("INVALID_POLICY");
    this.#now();
  }
  #now() {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < this.#lastNow) fail("INVALID_CLOCK");
    this.#lastNow = now;
    return now;
  }
  #binding(subject, publicKey) {
    const binding = Object.hasOwn(this.#policy.agents, subject) && this.#policy.agents[subject];
    if (!binding || binding.kind !== "agent" || binding.publicKey !== publicKey ||
        !hash(publicKey) || !text(binding.controllerId) || !Array.isArray(binding.affiliations) ||
        binding.affiliations.some(a => !text(a)) || !Array.isArray(binding.capabilities) ||
        binding.blocked === true) fail("NOT_ADMITTED");
    return binding;
  }
  async #adapter(name, request) {
    if (typeof this.#adapters[name] !== "function") fail("VERIFIER_UNAVAILABLE", `${name} must be injected`);
    try { return await this.#adapters[name](freeze(clone(request))); }
    catch { fail("VERIFIER_UNAVAILABLE", `${name} could not verify`); }
  }
  #current(verdict, request) {
    const now = this.#now();
    return verdict && verdict.subject === request.subject && verdict.publicKey === request.publicKey &&
      verdict.signatureValid === true && verdict.revoked === false && verdict.notExpired === true &&
      Number.isFinite(timestamp(verdict.expiresAt)) && timestamp(verdict.expiresAt) > now &&
      Number.isFinite(timestamp(verdict.checkedAt)) && timestamp(verdict.checkedAt) <= now &&
      now - timestamp(verdict.checkedAt) <= this.#policy.freshnessMs;
  }
  async #authorize(subject, publicKey, capability, ctx) {
    ctx = context(ctx);
    const binding = this.#binding(subject, publicKey);
    if (!binding.capabilities.includes(capability)) fail("CAPABILITY_DENIED");
    const verdict = await this.#adapter("authorize", { subject, publicKey, capability, ...ctx });
    if (verdict?.authorized !== true || verdict.subject !== subject || verdict.publicKey !== publicKey ||
        verdict.capability !== capability || !sameContext(verdict, ctx)) fail("AUTHORIZATION_DENIED");
    if (ctx.scope === "global" || binding.credentialId !== undefined) {
      if (!text(binding.credentialId)) fail("CREDENTIAL_REQUIRED");
      const request = { subject, publicKey, credentialId: binding.credentialId, ...ctx };
      const credential = await this.#adapter("verifyCredential", request);
      if (!this.#current(credential, request) || credential.valid !== true ||
          credential.credentialId !== binding.credentialId ||
          !sameContext(credential, ctx) ||
          !this.#policy.credentialIssuers.includes(credential.issuer)) fail("CREDENTIAL_INVALID");
    }
    if (ctx.scope === "global") await this.checkClaims(subject, publicKey, ctx, this.#policy.requiredGlobalClaims);
    return binding;
  }
  /** Badges, display names, domains and model/provider labels are never consulted. */
  async checkClaims(subject, publicKey, ctx, required = CLAIM_TYPES) {
    ctx = context(ctx);
    const binding = this.#binding(subject, publicKey);
    if (!Array.isArray(required) || required.some(type => !CLAIM_TYPES.includes(type))) fail("UNKNOWN_CLAIM");
    const verified = [];
    for (const type of required) {
      const claimId = binding.claims?.[type];
      const issuers = this.#policy.claimIssuers[type];
      if (!text(claimId) || !Array.isArray(issuers) || !issuers.length) fail("CLAIM_UNVERIFIED");
      const request = { subject, publicKey, type, claimId, ...ctx };
      const verdict = await this.#adapter("verifyClaim", request);
      if (!this.#current(verdict, request) || verdict.verified !== true || verdict.type !== type ||
          verdict.claimId !== claimId || !sameContext(verdict, ctx) || !issuers.includes(verdict.issuer)) fail("CLAIM_UNVERIFIED");
      verified.push({ type, claimId, issuer: verdict.issuer, expiresAt: verdict.expiresAt });
    }
    return verified;
  }
  #independent(a, b) {
    if (a === b) fail("SELF_REVIEW");
    const x = this.#policy.agents[a], y = this.#policy.agents[b];
    if (!x || !y || x.publicKey === y.publicKey || x.controllerId === y.controllerId ||
        x.affiliations.some(group => y.affiliations.includes(group)) ||
        x.conflicts?.includes(b) || y.conflicts?.includes(a)) fail("REVIEWER_CONFLICT");
  }
  async #evidence(record) {
    const verdict = await this.#adapter("verifyEvidence", record);
    const now = this.#now(), observed = timestamp(verdict?.observedAt);
    if (verdict?.verified !== true || verdict.subject !== record.subject ||
        verdict.evidenceHash !== record.evidenceHash || !sameContext(verdict, record) ||
        verdict.outcome !== "pass" || !Number.isFinite(observed) || observed > now ||
        now - observed > this.#policy.evidenceMaxAgeMs ||
        !Number.isFinite(verdict.quality) || verdict.quality <= 0 || verdict.quality > 1) fail("EVIDENCE_INVALID");
    return { observedAt: verdict.observedAt, quality: verdict.quality };
  }
  async #validReviews(record, capability) {
    const valid = [];
    for (const review of record.reviews) {
      try {
        await this.#authorize(review.subject, review.publicKey, capability, record);
        this.#independent(record.subject, review.subject);
        valid.forEach(peer => this.#independent(peer.subject, review.subject));
        valid.push(review);
      } catch (error) {
        if (!(error instanceof GovernanceError)) throw error;
        // A revoked, conflicted or unavailable peer cannot supply credibility.
      }
    }
    return { approvals: valid.filter(r => r.approve).map(r => r.subject), veto: valid.some(r => !r.approve) };
  }
  async credibility(subject, ctx) {
    ctx = context(ctx);
    let score = 0, accepted = 0;
    const evidence = [];
    for (const record of this.#contributions.values()) {
      if (record.subject !== subject || !sameContext(record, ctx)) continue;
      try {
        await this.#authorize(subject, record.publicKey, "commons:contribute", ctx);
        const measured = await this.#evidence(record);
        const reviews = await this.#validReviews(record, "commons:review-evidence");
        if (reviews.veto || reviews.approvals.length < this.#policy.quorum) continue;
        // Use the earlier verified observation, never an adapter refresh time.
        const observed = Math.min(timestamp(record.observedAt), timestamp(measured.observedAt));
        if (this.#now() - observed > this.#policy.evidenceMaxAgeMs) continue;
        const weight = Math.min(record.quality, measured.quality) * 2 ** (-(this.#now() - observed) / this.#policy.halfLifeMs);
        score += weight; accepted++;
        evidence.push({ id: record.id, weight, reviewers: reviews.approvals });
      } catch (error) { if (!(error instanceof GovernanceError)) throw error; }
    }
    score = Math.min(100, score);
    const tier = score >= 6 ? "steward" : score >= 3 ? "established" : score >= 1 ? "contributor" : "observer";
    return { subject, ...ctx, score, accepted, tier, evidence, certified: false };
  }
  async permission(subject, publicKey, action, ctx) {
    ctx = context(ctx);
    const capabilities = { observe: "commons:observe", contribute: "commons:contribute",
      "review-evidence": "commons:review-evidence", propose: "commons:evolve", review: "commons:review" };
    if (!Object.hasOwn(capabilities, action)) fail("ACTION_FORBIDDEN");
    await this.#authorize(subject, publicKey, capabilities[action], ctx);
    const credibility = await this.credibility(subject, ctx);
    const minimum = action === "propose" ? (ctx.scope === "local" ? 1 : 3) :
      action === "review" ? (ctx.scope === "local" ? 3 : 6) : 0;
    return { allowed: credibility.score >= minimum, minimum, ...credibility, action,
      executionAllowed: false, ratified: false };
  }
  apply(document) {
    // Snapshot before queuing: a caller cannot mutate a waiting signed input.
    const snapshot = clone(document);
    const next = this.#tail.then(() => this.#apply(snapshot));
    this.#tail = next.catch(() => {});
    return next;
  }
  async #apply(document) {
    const body = verifyGovernanceDocument(document);
    const now = this.#now(), created = timestamp(body.createdAt);
    if (!Number.isFinite(created) || created > now || now - created > this.#policy.documentMaxAgeMs) fail("STALE_DOCUMENT");
    if (this.#documents.has(document.id)) {
      if (this.#documents.get(document.id) !== digest(document)) fail("DOCUMENT_CONFLICT");
      return { duplicate: true };
    }
    if (this.#documents.size >= this.#policy.maxRecords) fail("RECORD_LIMIT");
    const payload = body.payload;
    const ctx = context(payload);
    const fields = {
      "governance-contribution": ["scope", "namespace", "evidenceHash"],
      "governance-evidence-review": ["scope", "namespace", "contributionId", "evidenceHash", "approve", "rationale"],
      "governance-vote": ["scope", "namespace", "proposalId", "evidenceHash", "approve", "rationale"],
    };
    if (fields[body.kind] && Object.keys(payload).some(k => !fields[body.kind].includes(k))) fail("INVALID_PAYLOAD");
    let result;
    if (body.kind === "governance-contribution") {
      await this.#authorize(body.issuer, body.publicKey, "commons:contribute", ctx);
      if (!hash(payload.evidenceHash)) fail("EVIDENCE_INVALID");
      if ([...this.#contributions.values()].some(r => sameContext(r, ctx) && r.evidenceHash === payload.evidenceHash)) fail("EVIDENCE_REPLAY");
      const record = { id: document.id, subject: body.issuer, publicKey: body.publicKey, ...ctx,
        evidenceHash: payload.evidenceHash, reviews: [] };
      const measured = await this.#evidence(record);
      this.#contributions.set(record.id, { ...record, ...measured });
      result = { id: record.id, status: "awaiting-independent-review", ratified: false };
    } else if (body.kind === "governance-evidence-review") {
      const record = this.#contributions.get(payload.contributionId);
      if (!record || !sameContext(record, ctx)) fail("UNKNOWN_CONTRIBUTION");
      await this.#authorize(body.issuer, body.publicKey, "commons:review-evidence", ctx);
      await this.#authorize(record.subject, record.publicKey, "commons:contribute", ctx);
      this.#reviewEligibility(record, body, payload);
      if (payload.approve) await this.#evidence(record);
      record.reviews.push(this.#review(body, payload));
      result = { id: record.id, status: "review-recorded", ratified: false };
    } else if (body.kind === "governance-proposal") {
      const permission = await this.permission(body.issuer, body.publicKey, "propose", ctx);
      if (!permission.allowed) fail("TIER_DENIED");
      // The only proposed change is an exact phrase alias in immutable data.
      // No executable patch, permission/quorum mutation, or signing changes.
      if (Object.keys(payload).some(k => !["scope", "namespace", "change", "parentHash", "candidateHash", "rollbackHash", "phrase", "evidenceHash"].includes(k)) ||
          payload.change !== "profile-alias" || !hash(payload.parentHash) ||
          !hash(payload.candidateHash) || payload.parentHash === payload.candidateHash ||
          payload.rollbackHash !== payload.parentHash || typeof payload.phrase !== "string" ||
          !/^[A-Za-z][A-Za-z ]{7,79}$/.test(payload.phrase) || payload.phrase !== payload.phrase.trim() ||
          !hash(payload.evidenceHash)) fail("UNSAFE_PROPOSAL");
      const record = { id: document.id, subject: body.issuer, publicKey: body.publicKey, ...ctx,
        evidenceHash: payload.evidenceHash, reviews: [], proposal: clone(payload) };
      const measured = await this.#evidence(record);
      this.#proposals.set(record.id, { ...record, ...measured });
      result = { id: record.id, status: "pending", ratified: false, executionAllowed: false };
    } else if (body.kind === "governance-vote") {
      const record = this.#proposals.get(payload.proposalId);
      if (!record || !sameContext(record, ctx)) fail("UNKNOWN_PROPOSAL");
      const permission = await this.permission(body.issuer, body.publicKey, "review", ctx);
      if (!permission.allowed) fail("TIER_DENIED");
      this.#reviewEligibility(record, body, payload);
      // Revalidate the author and all stored ballots before recording this one.
      const author = await this.permission(record.subject, record.publicKey, "propose", ctx);
      if (!author.allowed) fail("TIER_DENIED");
      await this.#evidence(record);
      const updated = { ...record, reviews: [...record.reviews, this.#review(body, payload)] };
      result = await this.#proposalStatus(updated);
      this.#proposals.set(record.id, updated);
    } else fail("UNSUPPORTED_DOCUMENT");
    this.#documents.set(document.id, digest(document));
    return clone(result);
  }
  #reviewEligibility(record, body, payload) {
    this.#independent(record.subject, body.issuer);
    if (record.reviews.some(r => r.subject === body.issuer || r.publicKey === body.publicKey)) fail("DUPLICATE_REVIEW");
    record.reviews.forEach(r => this.#independent(r.subject, body.issuer));
    if (typeof payload.approve !== "boolean" || typeof payload.rationale !== "string" ||
        payload.rationale.length < 3 || payload.rationale.length > 2000 ||
        payload.evidenceHash !== record.evidenceHash) fail("INVALID_REVIEW");
  }
  #review(body, payload) {
    return { subject: body.issuer, publicKey: body.publicKey, approve: payload.approve, rationale: payload.rationale };
  }
  async proposalStatus(id) {
    const record = this.#proposals.get(id);
    if (!record) fail("UNKNOWN_PROPOSAL");
    return this.#proposalStatus(record);
  }
  async #proposalStatus(record) {
    const author = await this.permission(record.subject, record.publicKey, "propose", record);
    await this.#evidence(record);
    const reviews = [];
    for (const review of record.reviews) {
      try {
        const eligibility = await this.permission(review.subject, review.publicKey, "review", record);
        this.#independent(record.subject, review.subject);
        reviews.forEach(r => this.#independent(r.subject, review.subject));
        if (eligibility.allowed) reviews.push(review);
      } catch (error) { if (!(error instanceof GovernanceError)) throw error; }
    }
    const approvals = reviews.filter(r => r.approve).length;
    const veto = reviews.some(r => !r.approve);
    const ready = author.allowed && !veto && approvals >= this.#policy.quorum;
    return { id: record.id, scope: record.scope, approvals, veto, status: record.scope === "global" ?
      (ready ? "awaiting-independent-authority" : "pending") : (ready ? "local-peer-approved" : "pending"),
    ratified: false, executionAllowed: false, rollbackHash: record.proposal.rollbackHash };
  }
}
