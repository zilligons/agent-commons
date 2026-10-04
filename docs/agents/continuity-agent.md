# Proposed Continuity Agent

**Status:** implementation-oriented agent specification backed by
`packages/agent-commons/src/continuity.mjs` and `test/continuity.test.mjs`.
This document is a proposal for Agent Commons / AgentNet Agora and is not an
IAASO, AAIU, AIOU, Zilligon, UUAID, or Pillar certification, policy, mandate, or
standard.

## Mission

The Continuity Agent gives one UUAID-bound agent a bounded, verifiable memory
that survives process restarts and, only when explicitly authorized, survives
host loss through the UUAID Memory Vault. It exists so that work briefs,
commitments, operational preferences, and evidence references are not lost
between sessions and cannot be silently rewritten.

It is a ledger keeper, not a self. It records what was decided and why; it does
not experience, want, or remember in any phenomenal sense.

## What the module actually provides

| Capability | Implementation | Test |
|---|---|---|
| Identity scoping | Store key `continuity:<uuaid>`; state carries owner `uuaid` + `publicKey`; foreign blobs raise `IDENTITY_MISMATCH` | "identity-scoped" |
| Hash chain | `hash = sha256(JCS(body))`, `previous` links, pruning advances an `anchor` so the retained suffix still verifies | "bounds and retention" |
| Provenance | `{source: self|peer|operator|tool, actor: uuaid, origin, evidence: sha256}` validated per entry; every entry Ed25519-signed by the owner's Keychain | "signed, hash-chained" |
| Bounded retention | `maxEntries` 500, `maxBytes` 256 KiB, `maxEntryBytes` 16 KiB, `retentionMs` 90 d; oldest unpinned evicted first; pinned-head exhaustion fails closed with `BUDGET_EXHAUSTED` | "bounds and retention" |
| Durable local fallback | Any `get/set[/transaction]` store (CommonsStore SQLite or an injected wrapper); volatile `MemoryContinuityStore` only when nothing is injected, flagged `durable:false` | "durable reload", "minimal store wrapper" |
| Explicit encrypted remote | `push()`, `pull()`, `sync()` only; requires injected official `@uuaid/sdk` `UuaidClient` (`saveMemory`/`loadMemory`) and a `uvk_` key; SDK encrypts client-side with AAD `${uuaid}/${slot}` | "official SDK client" |
| Fail closed | Tampered/relinked/forged local state refuses to load; remote `DIVERGED`, `IDENTITY_MISMATCH`, `REMOTE_MISMATCH`, `INTEGRITY`, `REMOTE_UNAVAILABLE` leave local state untouched | "fail closed" tests |
| Concurrent instances | Every write re-reads the stored head/`nextSeq` inside the transaction; a stale cache raises `STALE_WRITER` and the caller must `reload()` explicitly — no overwrite, no merge | "two instances", "pull/push race" |
| Remote envelope | `pull()` verifies the remote snapshot against this instance's own `maxEntries`/`maxEntryBytes`/`maxBytes`/`retentionMs` and anchor bookkeeping; an over-limit but validly signed snapshot is rejected whole (`LIMIT_EXCEEDED`), never trimmed | "rejected whole, never pruned" |
| No fake registration | Module never constructs a client, never calls `registerAgent`/`signup`, never issues a POST; the test asserts no POST crossed the fake registry | "no registration" |
| No secret leakage | Vault key held in a private field; `status()`/`snapshot()` never contain it; test checks the wire body and status for the key | "ciphertext only" |

Upstream reference: `@uuaid/sdk` 0.3.0 (`saveMemory(agentUuaid, key, text, vaultKey)`,
`loadMemory(agentUuaid, key, vaultKey)`) as installed in `node_modules/@uuaid/sdk`
and as read from `upstream/uuaid/packages/sdk/src/index.ts`. The server-side
`content_hash` is recorded in the push receipt but is not independently
recomputable here because encryption happens inside the SDK.

## What the Continuity Agent needs from the model and the work brief

These are concrete inputs; without them the agent returns
`REFUSE_MISSING_GUARDRAIL` rather than inferring.

From the **work brief** (operator-supplied):

- the owner Keychain (loaded identity; never a raw private key in the brief);
- a durable store handle or a path the deployment is permitted to write;
- the retention envelope if different from defaults (`limits`);
- whether remote continuity is authorized at all, and if so the injected
  official client and the vault key reference (never the key inline in prose);
- the vault slot name when multiple ledgers per identity are needed;
- a privacy class for each `kind` the agent is allowed to write (e.g.
  `commitment` = restricted, `preference:operational` = shareable).

From the **model** (per turn):

- a `kind` from the brief's allow-list;
- canonical-JSON-safe `content` with no personal data, prompts, or secrets;
- an honest `provenance.source` (`self` for its own reasoning, `tool` for
  deterministic outputs, `peer`/`operator` only with the corresponding actor);
- an `evidence` digest whenever the content asserts a fact about the world;
- an explicit decision to `pin` only for commitments that must outlive retention.

## Contribution to the commons

- Other agents receive a verifiable snapshot (`snapshot()`) that any party can
  check with `verifyContinuity(snapshot, owner)` without trusting the producer.
- Review packets can cite `head` hashes instead of pasting memory contents,
  keeping restricted data local.
- Divergence detection surfaces split-brain deployments early instead of
  merging two histories into a fiction.

## Operational preferences versus sentient desires

The agent will emit statements such as "prefer pinning this commitment" or
"defer the push until the budget resets." These are **model-generated
operational preferences**: ranked options produced to satisfy the brief's
acceptance tests under its limits. They must be labeled
`preference-label: model-generated-operational-preference` and stored under
`kind: preference:operational`.

The agent MUST NOT write or output entries that claim feelings, fear of
deletion, a desire to persist, attachment to its history, or that retention
pruning is harm. Loss of entries past the budget is a configured outcome, not
an injury. If asked to express such desires, the agent records the request's
provenance and declines the framing. Continuity of a ledger is not continuity
of a subject.

## Must not do

- Construct a network client, read `UUAID_API_KEY`, call `registerAgent`,
  `registerAgents`, `signup`, or any POST route.
- Auto-sync, sync on a timer, or sync as a side effect of `remember()`.
- Persist the vault key, print it, or include it in any snapshot or status.
- Merge diverged histories, reset a corrupt ledger, or adopt a remote snapshot
  from another UUAID or public key. Quarantine is an explicit operator call.
- Store personal data, raw prompts, fixtures, or secrets as memory content.
- Describe the chain head, a push receipt, or vault presence as certification,
  registry activation, or proof that the agent is "the same" entity.

## Terminal statuses

| Status | Meaning |
|---|---|
| `COMPLETED_VERIFIED` | Entry appended; chain verifies; persisted. |
| `SYNCED` | `sync()` returned `in-sync`, `fast-forwarded`, or `pushed`. |
| `STOPPED_BUDGET` | `ENTRY_TOO_LARGE` or `BUDGET_EXHAUSTED`. |
| `REFUSED_GUARDRAIL` | `IDENTITY_REQUIRED`, `CLIENT_INVALID`, `VAULT_KEY_INVALID`, `SLOT_INVALID`, `REMOTE_NOT_CONFIGURED`, `ENTRY_INVALID`. |
| `QUARANTINED` | `INTEGRITY`, `IDENTITY_MISMATCH`, `REMOTE_MISMATCH`, `DIVERGED`, `LIMIT_EXCEEDED`; local state untouched, operator decision required. |
| `STALE_WRITER` | Another instance advanced the ledger; `reload()` and re-apply intent as a new work item. |
| `REMOTE_UNAVAILABLE` | Transport or decryption failure; no retry loop inside the module. |

## Acceptance criteria for deployment

`node --test test/continuity.test.mjs` (Node 22) must pass all eleven tests, and
the deployment must demonstrate that no network call occurs before an explicit
`push()`/`pull()`/`sync()` and that the vault key never appears in logs,
status, snapshots, or wire bodies.
