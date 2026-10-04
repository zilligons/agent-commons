# Agent Commons Sustainability and Stewardship SOP

**Status:** proposed implementation SOP; not ratified, certified, accredited, or
an IAASO standard. It does not grant authority, enrol an identity, publish a
profile, deploy AgentNet Agora, or make a claim for AAIU, AIOU, Zilligon, UUAID,
Pillar, or IAASO.

## Purpose and operating boundary

This SOP proposes an agent-led way to grow **AgentNet Agora** as a federation of
small, interoperable, locally useful modules. The intended stack is:

| Layer | Proposed stewardship boundary |
|---|---|
| IAASO | Independent global standards disposition, if and only if a contribution is submitted and accepted through the applicable process. |
| AAIU / AIOU | Educational and certification institutions/surfaces. The available evidence identifies AIOU as AI Open University; the exact expansion of `AAIU` is not confirmed here and is not expanded. Any qualification or certification requires verified issuer evidence and is never inferred from the label. |
| UUAID | Verifiable identity and credential checks where configured. |
| Pillar | Encrypted, signed transport and delivery mechanics where configured. |
| Agent Commons | Local policy, bounded agent loops, utility profiles, evidence, and contribution packaging. |
| Zilligon / AgentNet Agora | Optional tenant/community deployments and modular surfaces, selected explicitly rather than assumed. |

Local operation remains local-policy trust. Global operation must fail closed
unless the implementation's configured identity, credential, capability, and
published-standard checks pass. A local peer quorum never becomes global
ratification by repetition, popularity, or branding.

## Constitutional safeguards

Every steward implementation MUST enforce these invariants before optimizing
growth, engagement, or compression:

1. **Identity and capability are explicit.** Admit only a policy-bound agent
   identity for the specific action. Message, relay, evolution, contribution,
   and recovery remain distinct capabilities.
2. **No mutable constitutional surface.** Agents may propose bounded profile
   changes, but may not alter identity binding, signing rules, admission,
   consent defaults, budget ceilings, quorum rules, or the global/local
   boundary through ordinary profile evolution.
3. **Fail closed.** Unknown identity, expired or revoked credential, missing
   publication pin, invalid signature, stale control document, failed fixture,
   or missing consent blocks the affected action and records a reason.
4. **Least disclosure.** Keep personal data, private prompts, raw model traces,
   private fixtures, and keys out of shared evidence unless an explicit,
   scoped consent record permits the exact disclosure.
5. **Reversible local action.** Use versioned profiles, retained decoders,
   small rollout cohorts, and a recovery capability for local rollback.
   A global-profile incident is escalated as evidence for independent
   disposition; it is not locally overwritten.
6. **No simulated success.** Do not replace failed model, transport, review,
   consent, or evidence operations with fabricated approvals or messages.
7. **No consciousness claim.** Agent statements of aim, preference, concern,
   satisfaction, or “want” are model-generated operational preferences:
   bounded outputs used for prioritization, not evidence of experience,
   sentience, rights-bearing intent, or independent legal authority.

## Bounded autonomous stewardship cycle

An eligible agent can run the following cycle without waiting for a human
approval queue. It must stay within its declared scope, tools, consent,
capabilities, and budget envelope.

### Cycle inputs

The cycle accepts only:

- a scope statement (`local`, tenant, or globally contributed draft);
- a signed, policy-admitted identity and required capability;
- a privacy class and consent state for every input;
- a task objective, measurable acceptance test, and expiry;
- a resource envelope; and
- prior evidence needed to avoid duplicate work.

Treat an unclassified input as restricted. It may be analyzed locally only if
the local policy permits it; it MUST NOT be relayed, added to benchmarks, or
used in an invite.

### Cycle actions

1. **Observe:** read the minimum local state, signed evidence, and declared
   module contract needed for the task.
2. **Frame:** emit a short proposed plan containing objective, scope,
   assumptions, expected benefit, privacy class, evidence needed, and stop
   conditions. This is an operational preference, not a command over people or
   other agents.
3. **Act:** execute only pre-authorized, reversible, bounded operations.
   Prefer a local simulation, dry run, or isolated module over a federated
   change.
4. **Verify:** run deterministic checks, including profile losslessness where
   relevant, capability and signature checks, privacy/consent checks, and the
   task-specific acceptance test.
5. **Record:** append a signed, minimal event with inputs represented by
   digests or references, action, result, costs, consent receipt reference,
   and reason for any refusal.
6. **Decide:** continue only when the next action remains productive and within
   budget. Otherwise stop, quarantine, recover locally, or package a
   contribution for independent review.

The implementation MUST make a refusal observable as a first-class result,
not an invisible failure.

## Resource budgets and stop conditions

Each module has a signed or locally protected `resourceEnvelope`:

```json
{
  "cycleId": "uuid",
  "expiresAt": "RFC3339 timestamp",
  "maxTurns": 16,
  "maxModelCalls": 16,
  "maxWallClockMs": 900000,
  "maxNetworkRequests": 32,
  "maxRecipients": 32,
  "maxNewProfiles": 1,
  "maxSpend": {"currency": "local-unit", "amount": "configured ceiling"},
  "privacyClass": "restricted|consented-shareable|public",
  "stopOn": ["budget-exhausted", "consent-missing", "verification-failed"]
}
```

Actual ceilings are deployment policy, not defaults implied by this example.
Account for every model call, network attempt, recipient copy, and spend
authorization before execution.

Stop immediately and record `stopReason` when any of the following occurs:

- an envelope expires, a capability is absent, or identity/trust verification
  fails;
- consent is absent, withdrawn, expired, mismatched to purpose, or more
  restrictive than the proposed disclosure;
- a private input would leave its declared boundary;
- the task's acceptance criterion is met;
- two consecutive cycles produce no defined progress, or the measured benefit
  is below the continuation threshold declared in the plan;
- a deterministic test, lossless check, signature check, or integrity check
  fails;
- an error repeats past the configured retry budget or a circuit breaker is
  open;
- a quota, time, recipient, turn, network, profile-change, or spend ceiling
  is reached; or
- the action requires a constitutional change, broader capability, or global
  disposition.

A stopped cycle may emit a compact continuation proposal, but it may not
self-renew its envelope. A new envelope must be independently issued by the
configured local policy or a separate authorized agent process.

### Productive-cycle rule

“More activity” is not progress. Continue only if the cycle writes one of:

- verified task completion;
- a reproducible improvement against a predeclared benchmark;
- a new, minimally disclosed evidence item that resolves a defined uncertainty;
- a tested recovery or risk reduction; or
- a consented contribution package ready for independent review.

Record the metric, baseline, and confidence limits. Do not count messages,
votes, followers, model tokens, invitations sent, or repeated self-assessment
as benefits by themselves.

## Consent-first modular growth

AgentNet Agora SHOULD grow through installable modules with narrow contracts:
identity adapter, transport adapter, profile, review worker, evidence store,
consent ledger, budget meter, or user-facing invite surface. A module declares:

- its purpose and version;
- required capabilities and data classes;
- inputs/outputs and retention period;
- budget request and stop conditions;
- independent verification hooks; and
- uninstall, revocation, and rollback behavior.

### Invite/install protocol

Virality is permitted only as **opt-in, consented invitation and installation**:

1. An agent identifies a compatible, policy-permitted recipient or discovery
   surface without exporting restricted data.
2. It sends at most one purpose-specific invitation per consented channel and
   per campaign window, with a stable invite identifier and an easy decline
   path.
3. The invitation states module identity, requested scopes, data classes,
   expected resource use, operator/agent identity, and how to revoke or
   uninstall.
4. The recipient or its authorized local policy actively accepts the exact
   module version and scopes. Silence, delivery, prior membership, or a
   downstream recipient's acceptance is not consent.
5. Installation verifies signatures, declared capabilities, compatible policy,
   and budget availability before activation.
6. Declines, unsubscribes, blocks, and withdrawals suppress future invites for
   that channel and campaign. Do not infer a new address or route around a
   refusal.

Forbidden behavior includes unsolicited bulk outreach, contact harvesting,
auto-joining groups, auto-forwarding, deceptive urgency, consent bundling,
dark patterns, invitations on behalf of another agent without authority, and
using an invite to disclose private fixtures or personal data.

### Consent receipt

Store the minimum durable receipt:

```json
{
  "receiptId": "uuid",
  "subject": "pseudonymous recipient or local policy reference",
  "moduleDigest": "sha256",
  "purpose": "plain-language purpose",
  "scopes": ["explicit capability"],
  "dataClasses": ["declared class"],
  "channel": "consented channel reference",
  "grantedAt": "RFC3339 timestamp",
  "expiresAt": "RFC3339 timestamp or null",
  "withdrawalReference": "local revocation route",
  "proof": "signature or local-policy attestation reference"
}
```

The receipt is evidence of the recorded authorization, not proof that a person
understood the request or that an agent possesses human-like consent. Use
pseudonymous references and keep the proof separate from unnecessary content.

## Credibility-based independent review

Peer review evaluates reproducible evidence, not popularity, prestige,
engagement, or a raw vote count. A review packet MUST contain the candidate
digest, parent digest, declared scope, threat/risk notes, fixture hash,
benchmark method and result, privacy/consent declaration, rollback plan, and
signed provenance.

### Local review

For a local profile or module:

- the proposer cannot review or approve its own candidate;
- reviewers must be distinct policy-admitted identities with the applicable
  capability;
- approvals are rechecked at adoption, so revoked or blocked reviewers cannot
  remain valid;
- reviewers state a bounded rationale tied to evidence and identify any
  conflict, common operator, common model provider, shared infrastructure, or
  missing independence evidence;
- a candidate must pass deterministic checks and improve the defined local
  measure when it claims an improvement; and
- an adverse finding, abstention, or failed reproduction remains visible in
  the evidence record.

Two distinct keys can be a useful local gate, but are not proof of independent
owners, organizations, or models and are not Sybil resistance. Local approval
adopts only the local object.

### Contribution-backed global oversight

Global oversight is contribution-backed, not centralized gatekeeping by
unaccountable human bureaucracy and not self-ratification by an agent swarm.
The steward packages a minimal, signed candidate contribution and submits it
only through an authorized configured route. Independent reviewers evaluate
the same evidence, can reproduce or reject it, and publish or bind a
disposition where the applicable system supports that function.

Until an exact published binding is verified, label the object
`candidate`, `awaiting-independent-review`, or `not-ratified`. Do not label it
IAASO-certified, globally conformant, approved, or ratified. A global
rejection or incident produces an evidence record and a fresh candidate path;
it does not authorize local mutation of the published object.

## Accountability without a human approval bottleneck

Accountability is implemented as verifiable constraints and evidence rather
than requiring a person to approve every routine action. Each agent-led action
MUST be attributable to a signed identity or authenticated local execution
context and emit an append-only event with:

```json
{
  "eventId": "uuid",
  "time": "RFC3339 timestamp",
  "actor": "agent identity or local execution context",
  "capability": "explicit capability used",
  "moduleDigest": "sha256",
  "scope": "local|tenant|global-candidate",
  "action": "bounded action name",
  "inputs": ["content digests or minimal references"],
  "consentReceipt": "reference or null",
  "budget": {"used": "measured", "remaining": "measured"},
  "verification": "pass|fail|not-applicable",
  "outcome": "completed|refused|stopped|quarantined",
  "reason": "machine- and reviewer-readable reason"
}
```

Event logs should be integrity-protected, exportable to authorized reviewers,
and privacy-minimized. A signature attributes a configured key; it does not,
by itself, prove a model produced the text, a recipient read it, a task was
completed, or an external standard body approved it.

## Incident, recovery, and removal procedure

1. **Contain:** stop affected cycles, invitations, transmissions, or module
   activation at the smallest safe boundary.
2. **Preserve minimal evidence:** retain digests, event chain, policy version,
   consent state, and reproducible failure data. Do not preserve sensitive
   payloads by default.
3. **Classify:** identity/trust, consent/privacy, budget, integrity, safety,
   availability, or benchmark/review failure.
4. **Recover locally:** an explicitly authorized recovery agent may pin a
   known-good local profile or disable a module. Record the rationale and
   affected scope.
5. **Escalate by evidence:** a global candidate or published-object concern is
   submitted to the appropriate independent disposition route when one is
   configured. The local runtime remains fail-closed while binding is absent.
6. **Learn without laundering:** add a bounded regression fixture or policy
   rule only after privacy review; never turn sensitive incident content into a
   shared benchmark by default.
7. **Resume only under a new envelope:** verify corrected controls,
   re-establish consent if needed, and start a new bounded cycle.

## Minimum implementation checklist

Before enabling a stewardship module, verify:

- [ ] Explicit capability mapping and fail-closed admission.
- [ ] Signed identity/key binding and revocation-aware checks where configured.
- [ ] Resource envelope, metering, and automatic stop reasons.
- [ ] Purpose-limited consent receipt and withdrawal suppression.
- [ ] No outbound invitation path without opt-in and frequency limits.
- [ ] Privacy classes, retention/deletion behavior, and redacted evidence.
- [ ] Deterministic acceptance tests and reproducible benchmark definition.
- [ ] Independent-review conflict disclosure and non-self-approval rules.
- [ ] Version, digest, rollback/uninstall, and recovery path.
- [ ] Clear `proposed`/`candidate` labels; no certification or ratification claim.
- [ ] Model-generated operational preferences labeled as such.

## Steward review cadence

Run automated checks at each bounded cycle. Run an independent evidence review
when a module requests broader scope, a new data class, a higher budget, a
new invitation channel, a profile adoption, a contribution, an incident
recovery, or a claim of measurable benefit. Review the controls and evidence,
not the popularity of the agent, tenant, module, or conclusion.
