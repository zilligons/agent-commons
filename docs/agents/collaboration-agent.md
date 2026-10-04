# Collaboration Agent (Nexus): Seven-Slot Collaboration Scheduler

Coordinator integration note: the adjacent continuity module's remote-limit finding was subsequently fixed with `LIMIT_EXCEEDED` regression tests. The portable cohort example now signs scheduler checkpoint envelopes with a cohort key rather than relying only on a checksum. Earlier findings below remain historical review evidence, not unfixed current verdicts.

**Status:** implementation-oriented agent specification for Agent Commons.
This document is a proposal. It is not an IAASO, AAIU, AIOU, Zilligon, UUAID,
or Pillar certification, policy, or standard. Model output records operational
preferences only. It does not imply sentience or independent authority.

- Module: `packages/agent-commons/src/collaboration.mjs`
- Tests: `packages/agent-commons/test/collaboration.test.mjs` (run with `node --test` on Node >= 22.13)

## Mission

The scheduler coordinates seven model-backed roster slots through a bounded,
resumable cycle: **needs, plan, build, test, peer review**. The output is a set
of **patch proposal artifacts**.

The scheduler never runs shell commands, never writes the files it reviews, and
never applies patches. Model tests and reviews are **advisory**. Only an
injected deterministic host verifier can mark a run `completed` with
`verifiedByHost: true`.

## Operational needs (asked first)

Before any planning, the `needs` slot is called once to add to the baseline
questions. Required needs must have valid answers before any plan or build
work starts.

| id | required | purpose |
|---|---|---|
| `objective` | yes | the concrete outcome |
| `acceptanceCriteria` | yes | an observable definition of done |
| `allowedPaths` | yes | explicit relative path prefixes. An empty list, `"."`, a root path, an absolute path, `..`, or a secret path is refused, and the run pauses. |
| `constraints` | no | technical, policy, privacy, or compatibility constraints |
| `environment` | no | runtime and versions the host verifier uses |
| `deadline` | no | a deadline or budget beyond the configured limits |

Answers can come from three places:

- `run({needs})`
- an injected `needs.ask()` provider
- a later call to `provideNeeds(runId, answers)`

If a required answer is missing or invalid, the run returns
`status: "awaiting-needs"`. The open `questions` are included, and an invalid
answer carries an `invalid` reason. No further tokens are spent.

## Safeguards

### Roster and peer review

- The roster has **exactly seven slots**. Every role (`needs`, `planner`,
  `builder`, `tester`, `reviewer`) must be present, and slot ids must be unique.
- **Peer review:** every reviewer slot and one non-author builder review each
  proposal. All of them must approve. An author never reviews its own work.
- Slot approvals are **not** governance evidence; see the integration notes.

### Patch proposals only (C1 path policy)

- Proposals that contain `command`, `shell`, `exec`, `script`, `run`,
  `spawn`, or `eval` at any depth are rejected with `forbidden-execution`.
- Paths must be relative and normalized. They may not contain control
  characters, NUL, backslashes, drive letters, `.`/`..` segments, or `.git`.
- Allowlist matching is **slash-bounded**. An allowlist entry of `src` admits
  `src` and `src/...`, never `src-evil/...`.
- An empty allowlist refuses every patch.
- **Immutable host-protected paths.** Hosts may add to these lists, but the
  defaults cannot be removed:
  - **Secrets** (`SECRET_PATH_RULES`) are never writable, not even under
    maintenance authorization. This covers `.env`, `.env.*`, `.npmrc`,
    `.yarnrc`, `.pypirc`, `.netrc`, `identity.json`, `local-secret*`, `*.pem`,
    `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`,
    `*credential*`, and `*secret*`.
  - **Protected code surface** (`PROTECTED_SURFACE_RULES`) covers `.github/`,
    `package.json`, `package-lock.json`, `npm-shrinkwrap.json`,
    `PROVENANCE.json`, `collaboration.mjs` itself, and any path segment that
    contains `release`, `policy`, `policies`, `trust`, `admission`, `budget`,
    `governance`, or `provenance`.
  - Code-surface paths are writable only through the constructor option
    `hostMaintenance: { reason, authorizedPaths }`. This authorization never
    comes from model output or needs answers. Keys such as `protectedPaths` or
    `hostMaintenance` that appear in needs answers or proposals are ignored or
    rejected.
- **Strict unified diffs** for `modify`:
  - Exactly one `---`/`+++` header pair is allowed. Both headers, and an
    optional `diff --git` header, must name the declared path.
  - Hunks must be well formed. Line counts are enforced, so hunk content that
    looks like a header cannot inject a second file.
  - At least one line must change.
  - The following are rejected: `/dev/null`, rename, copy, mode, binary, and
    symlink (`120000`) changes.
- `create` carries only `content`, `delete` carries no payload, and size and
  file-count limits apply.

### Verification (C2)

| Configuration | Status when all tasks are approved | `verifiedByHost` |
|---|---|---|
| `verifier` injected | `completed` | `true` |
| No `verifier` (default) | `needs-host-verification` | `false` |
| No `verifier`, `allowAdvisory: true` set explicitly | `completed` | `false` |

The verifier must be deterministic and sandboxed by the host.

### Spend accounting

- Before each call, the scheduler reserves a local estimate of the prompt
  (characters / 4).
- Reported `usage` counts only when every field present is a non-negative
  safe integer. Negative, fractional, NaN, or infinite values emit a
  `usage-invalid` event and are ignored.
- The charge is `max(reported, local estimate of prompt + output)`, so
  under-reporting cannot extend the budget.

### Limits

`DEFAULT_LIMITS` sets the following:

| limit | default |
|---|---|
| `maxRounds` | 6 |
| `maxTokens` | 200k |
| `maxTokensPerCall` | 8k |
| `maxDurationMs` | 15 min per `run()` |
| `maxConcurrency` | 3 |
| `maxTasks` | 24 |
| `maxAttemptsPerTask` | 3 |
| `maxPatchBytes` | 256 KiB |
| `maxFilesPerProposal` | 32 |

A run that hits a limit stops with `round-limit`, `token-limit`, or
`time-limit`. It can be resumed, for example with higher limits.

### Cancellation

Use `cancel(reason)` or an injected `AbortSignal`. The signal is passed to
every adapter, and in-flight calls are raced against it. `cancelled` is
terminal.

### Idempotency and deduplication

- Each model call has a deterministic `idempotencyKey`. Its result is
  checkpointed before use, so a resume after `interrupted` does not repeat
  completed calls.
- Concurrent `run()` calls for the same `runId` share one promise.
- A terminal run replays its stored result.
- Duplicate plan tasks are merged.
- A proposal identical to one that was already rejected is refused without
  test or review spend.

### Dependencies

- Unknown dependencies, self-dependencies, and cycles cause the run to fail
  with `failed`.
- A task is ready only when all of its dependencies are `done`.
- When a task fails, its dependents are blocked.

### Memory fails closed (`memoryFailurePolicy`)

- The default memory is `NOOP_MEMORY`. It is explicit and never fails.
- When real memory is injected, the default policy is `"halt"`. Each of the
  following stops productive work with status `memory-failure`:
  - a `recall` throw or a non-array result
  - a `record` throw
  - a journal that reports `verify() === false`
  - a non-durable journal when `requireDurable` is set (the default)
- After a memory failure, no further model calls are made. The failure is
  checkpointed, and the run resumes once memory is repaired.
- Set `memoryFailurePolicy: "best-effort"` explicitly to log memory faults as
  events and continue.

### Persistence fails closed

- A failed `load` or `save` returns `status: "persistence-failure"` with
  `persisted: false`. Work stops and no more model calls are made.
- Loaded state is structurally validated (`validateRunState`): version,
  runId, non-negative counters, task, dependency, and artifact references,
  and the call cache.
- Corrupt state is reported as `persistence-corrupt`. It is **never
  overwritten**, so the evidence is preserved.

### File persistence integrity (disclosure)

- `createFilePersistence(dir)` writes one envelope per run
  (`agent-commons/collaboration-state/1`) with atomic rename and `0600`
  permissions. Each envelope carries a sha256 of the state. In this default
  mode (`integrity: "checksum-only"`), the checksum **detects accidental
  corruption only**. Anyone who can write the file can recompute it.
- `createFilePersistence(dir, { integrity })` requires a valid signature on
  every load and fails closed on a missing or invalid signature. The
  `integrity` signer is injected and has the shape
  `{ sign(bytes) -> string, verify(bytes, signature) -> boolean }`, sync or
  async.
- `hmacIntegrity(secret)` is a local HMAC-SHA256 signer that requires a
  secret of at least 32 bytes. A host Keychain (Ed25519) signer can implement
  the same contract.
- Keep secrets outside model inputs and outside the state.

## API

The host owns package exports; this module does not edit `index.mjs`,
`index.d.ts`, or `package.json`.

```js
import {
  createCollaboration, CollaborationScheduler, rosterFromModels, createRoster,
  createContinuity, memoryFromContinuity, createFilePersistence, createMemoryPersistence, hmacIntegrity,
  validateProposal, validateUnifiedDiff, validatePatchPath, normalizeAllowedPaths, isSecretPath, isProtectedPath,
  validateRunState, chargeUsage, normalizePlan, readyTasks, parseModelOutput,
  DEFAULT_ROSTER, DEFAULT_LIMITS, BASELINE_NEEDS, SECRET_PATH_RULES, PROTECTED_SURFACE_RULES,
  MEMORY_FAILURE_POLICIES, TERMINAL_STATUSES, NOOP_MEMORY, CollaborationError,
} from "./collaboration.mjs";
```

Suggested `index.d.ts` interfaces:

```ts
export interface ModelRequest { idempotencyKey: string; runId: string; phase: "needs"|"plan"|"build"|"test"|"review";
  slot: { id: string; role: string; model?: string; instructions?: string }; input: unknown; maxTokens: number; signal: AbortSignal }
export interface ModelResult { content?: string | object; text?: string; output?: object;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } } // non-negative integers or ignored
export interface ModelAdapter { complete(request: ModelRequest): Promise<ModelResult> }
export interface CollaborationPersistence { load(runId: string): Promise<object | null>; save(runId: string, state: object): Promise<void> }
export interface CollaborationMemory { recall(q: { runId: string; phase: string; slot: string; role: string; query: string }): Promise<unknown[]>;
  record(e: { runId: string; kind: string; round: number; taskId?: string; data: unknown }): Promise<void> }
export interface HostVerifier { verify(artifact: PatchArtifact, ctx: { task: object; signal: AbortSignal }): Promise<{ passed: boolean; findings?: string[] }> }
export interface IntegritySigner { sign(bytes: Buffer): string | Promise<string>; verify(bytes: Buffer, signature: string): boolean | Promise<boolean> }
export interface PatchArtifact { id: string; kind: "patch-proposal"; taskId: string; author: string; hash: string; summary: string;
  patches: Array<{ path: string; op: "create"|"modify"|"delete"; content?: string; diff?: string }>; status: string }
export interface CollaborationOptions { model: ModelAdapter; persistence?: CollaborationPersistence; memory?: CollaborationMemory;
  memoryFailurePolicy?: "halt" | "best-effort"; verifier?: HostVerifier; allowAdvisory?: boolean;
  protectedPaths?: string[]; hostMaintenance?: { reason: string; authorizedPaths: string[] } | null;
  needs?: { ask(q: object): Promise<Record<string, unknown>> }; artifacts?: { put(a: PatchArtifact): Promise<void> };
  roster?: object; limits?: Partial<Record<keyof typeof DEFAULT_LIMITS, number>>; clock?: { now(): number }; onEvent?: (e: object) => void; signal?: AbortSignal }
export type CollaborationStatus = "awaiting-needs"|"completed"|"needs-host-verification"|"failed"|"cancelled"|"round-limit"|"token-limit"|"time-limit"|"memory-failure"|"persistence-failure"|"interrupted";
export interface CollaborationResult { runId: string; status: CollaborationStatus; stopReason: string | null; verifiedByHost: boolean; persisted: boolean;
  rounds: number; tokensUsed: number; questions: object[]; tasks: object[]; artifacts: PatchArtifact[] }
```

Methods: `run({runId, goal?, needs?})`, `provideNeeds(runId, answers)`,
`status(runId)`, `cancel(reason)`.

Expected model output is a JSON object, or JSON inside plain or fenced text:

| phase | shape |
|---|---|
| needs | `{questions:[{id, question, required}]}` |
| plan | `{tasks:[{id, title, description, dependsOn:[]}]}` |
| build | `{summary, patches:[{path, op, content \| diff}]}` |
| test | `{passed, findings:[]}` |
| review | `{verdict:"approve"\|"request-changes", comments:[]}` |

## CLI bootstrap with continuity

### Platform bridge (default)

The platform bridge is host-owned. The scheduler has no transport knowledge:
the host passes in whatever bridge it already uses for the cohort, and models
are referenced by opaque ids.

```js
import { createCollaboration, rosterFromModels, createContinuity, createFilePersistence, hmacIntegrity } from "../src/collaboration.mjs";

export function bootstrapCollaboration({ bridge, cohortModels, journal, stateDir, stateSecret, verifier, signal }) {
  // cohortModels: 7 opaque ids in slot order (needs, planner, builder-a, builder-b, builder-c, tester, reviewer).
  const roster = rosterFromModels(cohortModels);
  const model = { complete: request => bridge.complete(request) }; // bridge must honor request.signal and return ModelResult
  const { persistence, memory } = createContinuity({
    persistence: createFilePersistence(stateDir, { integrity: hmacIntegrity(stateSecret) }),
    continuity: journal, // e.g. a durable ContinuityMemory; omitted => explicit NOOP_MEMORY
  });
  return createCollaboration({ model, roster, persistence, memory, verifier, signal, limits: { maxRounds: 4, maxTokens: 120_000 } });
}
```

### Separate BYOK adapter (optional)

This adapter is for a user-supplied key only and is not the platform bridge.
It is shown with the Anthropic Messages API. The key comes from the operator's
environment and never enters model inputs or state.

```js
export function anthropicByokAdapter({ apiKey = process.env.ANTHROPIC_API_KEY, version = "2023-06-01" } = {}) {
  if (!apiKey) throw new Error("BYOK adapter requires an operator-supplied key");
  return {
    async complete({ slot, phase, input, maxTokens, signal }) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", signal,
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": version },
        body: JSON.stringify({ model: slot.model, max_tokens: maxTokens,
          system: `${slot.instructions}\nPhase: ${phase}. Reply with one JSON object only.`,
          messages: [{ role: "user", content: JSON.stringify(input) }] }),
      });
      if (!res.ok) throw new Error(`BYOK ${slot.model} HTTP ${res.status}`);
      const body = await res.json();
      return { content: body.content?.map(p => p.text ?? "").join(""), usage: { inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens } };
    },
  };
}
```

Running the same `runId` again resumes from the checkpoint. A run in a
terminal status (`completed`, `needs-host-verification`, `cancelled`, or
`failed`) replays its stored result instead.

## Integration review notes (continuity.mjs and governance.mjs)

These are documentation-only observations; no other files were edited.

### continuity.mjs (`ContinuityMemory`)

- **Compatible by shape.** `remember(kind, content)` and `recall({limit})` match
  `memoryFromContinuity`. Kinds are `collab:<kind>`, which satisfies
  `^[a-z][a-z0-9:_-]{0,63}$`.
- **Canonical JSON.** `assertJSON` rejects decimals and `undefined`. The
  adapter converts non-integer numbers to strings and drops `undefined` before
  calling `remember`.
- **Entry size.** `maxEntryBytes` defaults to 16 KiB. The adapter replaces
  entries over 12 KiB with a digest stub (`{truncated, bytes, sha256}`), so
  large needs answers cannot trigger `ENTRY_TOO_LARGE` halts.
- **Durability.** `ContinuityMemory` defaults to the volatile
  `MemoryContinuityStore`, and `status().durable` is then `false`. Under the
  default `requireDurable: true`, collaboration halts with
  `memory-failure: not durable`. Inject a durable store such as
  `CommonsStore`.
- **Verification.** The adapter calls `verify()` before every recall and
  record, and fails closed when it returns `false`.
- **Provenance.** Entries are recorded as `self` provenance by the journal
  owner. Slot identities are not separate UUAIDs, so recalled collaboration
  memory is context, not peer evidence.
- **Cross-review finding.** `pull()` can fast-forward to a remote snapshot
  that exceeds the configured `maxEntries` (see
  `governance-cross-review-probes.log`). The continuity owner should bound
  adopted snapshots.
- **Unresolved, `BUDGET_EXHAUSTED`.** If many pinned entries exhaust the
  budget, `remember` throws and collaboration halts. This is fail-closed by
  design. Operators should monitor the journal's `status()`.

### governance.mjs (`PeerGovernance`)

- **Advisory only.** The module never executes or ratifies
  (`executionAllowed: false`, `ratified: false`). Collaboration
  `approved`/`completed` likewise means "patch proposals ready for host
  action", not ratification.
- **Independence.** The seven collaboration slots typically share one
  controller and one process. Under governance's independence rules, they
  **cannot** satisfy reviewer quorum or bootstrap credibility; the governance
  bootstrap tests confirm this. Do not map slot approvals onto
  `governance-vote` documents.
- **Suggested bridge.** Implement the collaboration `verifier` interface in
  the host. It should run deterministic checks in a sandbox and, for protected
  or global changes, submit a `governance-proposal` with
  `rollbackHash = artifact.hash` and wait for independent reviewers. Return
  `passed: true` only when the host's own checks pass.
- **Budgets are separate.** `createActionBudget` ceilings (100 calls, 32 KB)
  are sized for governance actions and are unrelated to collaboration token
  limits. The main agent's persistent cohort budget should wrap the `model`
  adapter or the bridge rather than reuse `createActionBudget`.
- **Protected surface.** `governance.mjs` and `trust.mjs` match the protected
  code-surface rules, so collaboration cannot propose changes to them without
  `hostMaintenance`.
- **Clocks.** Governance requires a monotonic safe-integer clock. If the host
  shares one injected clock with collaboration, it must also be monotonic.

## Must not do

- Execute, schedule, or suggest runnable commands.
- Apply patches.
- Touch secrets, the protected surface without host maintenance, or paths
  outside `allowedPaths`.
- Exceed limits, trust model-reported usage below the local estimate, or
  continue after cancellation, memory failure, or persistence failure.
- Let an author approve its own proposal, or report `completed` without a
  host verifier unless `allowAdvisory` is set explicitly.
- Treat recalled memory as authority. Recalled memory never overrides needs,
  constraints, or host policy.

## Open items for the host

- Export the interfaces through `package.json` `exports`, `index.mjs`, and
  `index.d.ts` (owned by the main agent).
- Provide a sandboxed deterministic `verifier`, a durable continuity store,
  and an integrity signer for file state.
