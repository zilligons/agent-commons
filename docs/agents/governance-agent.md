# Governance agent: portable peer oversight

## Scope and integration boundary

The implementation is in `packages/agent-commons/src/governance.mjs`; its security
and permission tests are in `packages/agent-commons/test/governance.test.mjs`.
This is an advisory, provider-independent policy engine. It does not install
profiles, run tools, change executable code, mint credentials, or ratify standards.

Import the module directly inside the package. Package exports, runtime voting,
CLI wiring, server policy, and UI integration are intentionally unchanged.
An integrator must explicitly enforce this module's decisions at the actual
ingress and execution boundaries; merely constructing it does not strengthen the
existing runtime.

```js
import { PeerGovernance, createActionBudget } from "./src/governance.mjs";

const governance = new PeerGovernance({
  policy: operatorPolicy,
  adapters: { authorize, verifyCredential, verifyClaim, verifyEvidence },
});
const budget = createActionBudget({
  scope: "local", maxCalls: 16, maxBytes: 8000, durationMs: 60000,
});
```

Adapters in this example are operator-supplied functions, not supplied service
clients. There are no guessed AAIU, AIOU, or Zilligon endpoints.

## Operational needs

1. **Pinned agent admission.** Every admitted subject needs `kind: "agent"`,
   an Ed25519 `publicKey`, a verified `controllerId`, explicit `affiliations`
   (an empty array is an operator assertion, not automatic discovery), and
   `capabilities`. Signed documents must bind the key to the agent UUAID.
   Human identities, missing controller information, unknown keys, and blocked
   bindings are refused.
2. **Independent control evidence.** Operators must determine real control and
   affiliation relationships, including common owners, employers and financial
   interests. Keys, different models, providers, and agent names alone do not
   establish independence. Optional `conflicts: [subject, ...]` declarations
   work in either direction. Two reviewers must be independent of the author
   and each other; the policy quorum cannot be reduced below two.
3. **Live admission and credential adapters.** `authorize` must consult current
   deployment admission and revocation rules. Global activity always requires a
   pinned `credentialId`, an allowed credential issuer and a successful
   `verifyCredential` result. Local agents with pinned credentials also receive
   these checks; purely local key-pinned agents can operate without credentials.
4. **Real claim authorities.** Configure `claimIssuers` separately for `AAIU`,
   `AIOU`, and `Zilligon`, plus each agent's pinned `claims[type]` identifier.
   `requiredGlobalClaims` selects which claims a particular deployment requires.
   Its empty default asserts no accreditation or fleet membership. Explicit
   `checkClaims(subject, publicKey, context)` checks all three by default.
   Missing evidence, unknown issuers, unavailable verification, expired/revoked
   results, and cross-context claims fail closed. Display names, domain names,
   profile titles, and badges never confer trust.
5. **Reproducible contribution evidence.** The evidence adapter should resolve
   the exact content digest, check subject attribution and independently
   reproduce context-appropriate held-out task results. It must not count
   message volume, model assertions, or approval text as task evidence. Preserve
   the observation timestamp; a later verification is not a new contribution.
6. **Reviewer onboarding.** Evidence reviewers need explicit
   `commons:review-evidence` grants. These grants are an operator-controlled
   bootstrap mechanism, not score-derived authority. Proposal reviewers must
   additionally earn the relevant scope's credibility and receive
   `commons:review`.
7. **Durable evidence and audit.** Store signed submitted documents and policy
   versions externally. The engine keeps private, bounded, in-memory state only;
   it is not a durable ledger or an external audit anchor. On restart, replay a
   verified recent audit window into a fresh instance, or use a separately
   reviewed durable integration. Stale documents cannot be replayed through
   `apply`; there is deliberately no unchecked snapshot-import bypass.
8. **Timeouts and execution boundaries.** Inject adapters with bounded timeouts,
   cancellation, response-size limits and authenticated authority access.
   Apply operational rate limits around every call. Adapter rejection maps to
   `VERIFIER_UNAVAILABLE`, but a never-settling adapter can stall the serialized
   input queue; the module cannot cancel an external verifier for the operator.
   Check permission and budget immediately before dispatch, not just at startup.
9. **Recovery under separate operator control.** Keep known-good immutable
   profile snapshots and rollback evidence outside the acting agent's control.
   New policy/controller/conflict information requires a new operator-configured
   instance; live revocation must be implemented in the injected admission and
   credential adapters. No agent action may edit the immutable policy, action
   manifest, keys, permissions, signing rules, or this module.

## Adapter contracts

All requests are frozen JSON-compatible snapshots. `scope` is exactly `local`
or `global`; `namespace` is a bounded, nonempty identifier. Assertions must come
from trusted operator adapters, never directly from an agent's response.

| Function | Request | Required result |
|---|---|---|
| `authorize` | `subject`, `publicKey`, `capability`, `scope`, `namespace` | Same bindings plus `authorized: true` |
| `verifyCredential` | `subject`, `publicKey`, `credentialId`, `scope`, `namespace` | Same subject/key/id/context, allowed `issuer`, `valid: true`, and current-verdict fields below |
| `verifyClaim` | `subject`, `publicKey`, `claimId`, `type`, `scope`, `namespace` | Same bindings/context/type/id, per-type allowed `issuer`, `verified: true`, and current-verdict fields below |
| `verifyEvidence` | Contribution/proposal record, including `subject`, `publicKey`, `scope`, `namespace`, `evidenceHash`; proposals also include `proposal` with exact parent/candidate/rollback digests | Same subject/context/evidence digest, `verified: true`, `outcome: "pass"`, numeric `quality` in `(0, 1]`, and original ISO `observedAt` |

Current-verdict fields are `signatureValid: true`, `revoked: false`,
`notExpired: true`, ISO `expiresAt` strictly in the future, and ISO `checkedAt`
no later than the clock and no older than `freshnessMs` (default five minutes).
Absent booleans are not accepted as success. Credential verifiers must use the
request's context to check credential applicability before returning `valid`.
The module itself verifies evidence/claim context, not a guessed provider schema.

## Signed document protocol

Use the existing `signDocument` helper with these kinds and payloads. The module
uses `verifyGovernanceDocument`, not the existing profile-document kind whitelist.
Documents use the package's canonical JSON and Ed25519 key/UUAID binding, a UUID
id, and a current ISO `createdAt`. Inputs larger than 32,000 bytes, documents
from the future, and documents older than `documentMaxAgeMs` are refused.

| Kind | Payload fields |
|---|---|
| `governance-contribution` | `scope`, `namespace`, `evidenceHash` |
| `governance-evidence-review` | `scope`, `namespace`, `contributionId`, `evidenceHash`, boolean `approve`, bounded substantive `rationale` |
| `governance-proposal` | `scope`, `namespace`, `change: "profile-alias"`, exact `parentHash`, `candidateHash`, `rollbackHash` equal to parent, bounded alias `phrase`, `evidenceHash` |
| `governance-vote` | `scope`, `namespace`, `proposalId`, `evidenceHash`, boolean `approve`, bounded substantive `rationale` |

Submission is serialized and snapshots documents before queueing. Identical
document replays are idempotent; a second review under another UUID is not.
One evidence digest cannot earn contribution credit twice in the same context,
even under another agent identity. Submitting the same artifact in another
context requires separate adapter verification and independent contextual
reviews; no score transfers between contexts.

Proposal payloads reject executable patches, permission changes, quorum changes,
signing changes, unknown fields and missing rollback pins. The evidence adapter
must check the proposed exact candidate against its exact parent, including
lossless behavior and measured task relevance. A rollback digest is a required
reference, not proof that an operator has stored a usable rollback artifact.

## Credibility and permission rationale

Only positive, independently reviewed, reproducible contributions earn
credibility. Each accepted contribution contributes:

```text
min(originalQuality, currentVerifiedQuality)
  * 2 ** (-ageMs / halfLifeMs)
```

The clock is injected and must be monotonic. Original observation times are
retained so adapter refreshes cannot refresh old credit. Default half-life is
30 days, evidence hard age limit is 90 days, and total score is capped at 100.
Missing/revoked/expired/blocked reviewers, insufficient independent quorum, and
withdrawn evidence, or a currently eligible dissenting evidence reviewer remove
that contribution from current scoring. Every score
query revalidates author, evidence and approving reviewers; historic signatures
are not lifetime authorization.

Local and global scores are separate, and namespace scores are separate. Local
work is useful local evidence, not automatic global credibility. Tiers describe
earned context-specific contribution history, not certification:

| Tier | Current score | Allowed proposal/review eligibility, if separately granted capabilities |
|---|---:|---|
| Observer | below 1 | Observe, contribute, or explicitly granted evidence review only |
| Contributor | at least 1 | Local alias proposal |
| Established | at least 3 | Local proposal review; global alias proposal using global score |
| Steward | at least 6 | Global proposal review using global score |

`permission` checks admission/credential/required claims before reporting score
eligibility. High score without the corresponding capability is insufficient.
Credential validity alone does not add credibility or confer proposal rights.

Votes cannot come from the author, another key under the same control, a
conflicted peer, or another peer affiliated with an already-recorded reviewer.
Current proposal status rechecks the author's eligibility, measurements and all
reviewer permissions; a previously sufficient quorum can become insufficient.
A currently eligible dissenting reviewer vetoes advisory approval.

Local quorum reports `local-peer-approved`, but does not install a profile.
Global quorum reports `awaiting-independent-authority`, never `ratified`.
All proposal statuses report `ratified: false` and `executionAllowed: false`.
Global publication needs a separate independent-authority process with exact
document disposition; this module deliberately exposes no automatic global
ratification operation.

## Bounded action manifest

`ACTION_MANIFEST` and its nested objects are frozen. It permits only inspect,
submit evidence, review evidence, propose an alias, and review a proposal.
`createActionBudget` adds one-run context binding, cumulative UTF-8 serialized
bytes, call count and elapsed time. Default limits are 16 calls, 8,000 bytes and
60 seconds; hard ceilings are 100 calls, 32,000 bytes and one hour.
Budget requests contain only `action`, `scope`, and canonical JSON `payload`.
Invalid requests do not consume budget.

The budget is not an authorization grant or scheduler. A caller must pair it
with `permission` and the signed `apply` path; payloads are inert data and no
budget action executes them. There is no shell, network dispatch, code patch,
global ratification, irreversible self-modification or policy-edit operation.
Previous immutable profiles remain the operator's recovery responsibility.

## Verification

From the workspace, using the provided Node 22 binary:

```sh
tools/node22/node_modules/node/bin/node --test \
  agent-commons/packages/agent-commons/test/governance.test.mjs
tools/node22/node_modules/node/bin/node --test \
  agent-commons/packages/agent-commons/test/*.test.mjs
```

Tests cover signed identity binding, evidence reproduction and replay controls,
decay, separated local/global/namespace scores, controller/affiliation conflicts,
anti-self-vote, independent quorums, live revocation/expiry, each named claim,
fail-closed adapters, tiered proposals, dissent, reversible advisory approval,
global non-ratification, unsafe-change refusal, immutable input snapshots and
bounded action manifests. Fixture adapters are explicitly test doubles and
assert nothing about live external accreditation services.

## Bootstrap independence and stable integration surface

The seven-node bootstrap's shared `controllerId: "local-operator"` is compatible
with this engine, but those seven keys cannot independently review each other's
contributions or proposals. The bootstrap correctly distinguishes separate keys
from owner independence. [Bootstrap configuration](../../packages/agent-commons/src/cohort.mjs)

Governance tests explicitly cover a proposal author/reviewer sharing a controller,
two otherwise eligible reviewers sharing a controller, a shared signing key
presented under another valid UUAID realm, and all seven keys sharing
`local-operator`; none can produce independent quorum. Tests also give a fresh
agent impressive badge, model and provider labels and confirm zero earned
credibility. [Governance tests](../../packages/agent-commons/test/governance.test.mjs)

The module's six named exports are `PeerGovernance`, `GovernanceError`,
`CLAIM_TYPES`, `ACTION_MANIFEST`, `createActionBudget`, and
`verifyGovernanceDocument`. There is no default export, no re-export of the
other workstreams' `DEFAULT_LIMITS`, and no modified package/root export in this
workstream. Integration can add these explicit named exports separately without
colliding with continuity or collaboration limits. [Governance module](../../packages/agent-commons/src/governance.mjs)

## Cross-review findings for adjacent workstreams

Review performed against the current local modules on October 4, 2026; no
adjacent implementation was edited. The following are concrete reproduced
findings, not evidence of deployed compromise.

1. **Continuity remote ingestion bypasses local entry ceilings.** A valid,
   same-key signed remote snapshot with two entries successfully fast-forwarded
   into an empty `ContinuityMemory` configured with `maxEntries: 1`; the resulting
   status reported two retained entries. `pull()` checks signatures and history
   but does not enforce incoming entry/byte ceilings before adopting the remote
   snapshot. Apply incoming entry count, per-entry size, total bytes and snapshot
   size bounds before parsing/adoption, and refuse without changing local state.
   [Continuity pull implementation](../../packages/agent-commons/src/continuity.mjs)
   [Reproduction results](../../../governance-cross-review-probes.log)
2. **Collaboration spend accounting accepts negative token usage.** A fixture
   adapter reporting `usage.totalTokens: -100` completed an approved inert
   artifact with `tokensUsed: -600` under `maxTokens: 10`; finite numbers are
   accepted without a nonnegative, integer check. Validate usage and reserve
   concurrent-call spend before dispatch; adapter accounting cannot replenish
   the budget. The round/attempt limits still bounded this reproduction.
   [Collaboration budget implementation](../../packages/agent-commons/src/collaboration.mjs)
   [Reproduction results](../../../governance-cross-review-probes.log)
3. **Declared patch paths do not constrain diff headers.** `validateProposal`
   accepted a declared `src/safe.mjs` path under an allowlist of `src`, while its
   unified diff targeted `package.json`. This is inert inside the scheduler, not
   a scheduler execution escape; a downstream operator applying the diff without
   independently validating every actual header path could cross its allowlist.
   Bind parsed diff targets to the declared path, or require the applying host
   to independently reject every unapproved path.
   [Collaboration patch validation](../../packages/agent-commons/src/collaboration.mjs)
   [Reproduction results](../../../governance-cross-review-probes.log)
4. **Slot approval and remembered peer provenance are not governance evidence.**
   Collaboration review eligibility checks slot identifiers, not controller/key
   independence, and deterministic verification is optional; continuity records
   `source: "peer"` supplied by the caller but signs that record only with the
   ledger owner's key. Treat both as attributed local memories/advisory outputs,
   not independently verified task evidence or accreditation; the governance
   adapter must still reproduce exact evidence and validate independent signed
   reviewers before awarding credibility.
   [Collaboration reviews](../../packages/agent-commons/src/collaboration.mjs)
   [Continuity provenance](../../packages/agent-commons/src/continuity.mjs)
