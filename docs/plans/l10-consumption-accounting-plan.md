# L10 consumption accounting, reservation settlement and turn ladder

Status: pre-deploy blockers B1/B2/B4/B5 fixed in the working tree on 2026-10-24; pending independent security and verification reviews. No ship approval. The earlier one-use Sol generation authority remains spent.
Author: the implementation author.
Prepared: 2026-10-20 06:19:16 PDT, Pacific clock read after source inspection and atomic path claim.
Served-by: independently unprovable from Codex logs.
Source: the implementation worktree, HEAD `baae8adb94ce260a032e901d01a4a9c7134abede`; its tree matches merged main `6396ebccd23817a9bdf53e831d26baaf0cc555a7`.

## Scope, result and non-goals

Implement durable, bounded live-call admission and settlement for all seven founding cohort slots: continuity, governance, collaboration, release, security, integration and sustainability. A healthy admission must reserve sufficient capacity before dispatch, settle once from trustworthy usage or retain a conservative charge, and update the actual cohort diagnostic.

The current checkpoint requires the package suite (437 prior cases plus new coverage) and accounting fixtures to pass, followed by seven-slot non-generative provider counting. Successful counting is `PREFLIGHT_OK`, `preflightReady:true`, `available:false`; it does not establish generation availability or live settlement.

Prism/integration and Terra/sustainability are now explicitly in scope. Out of scope: credential-store/file/value inspection, rotation or account changes; provider/model substitution; billing subscription, witness, process isolation, consent or trust changes; paid generation, deployment, publishing and unrelated cleanup. Existing metering/permit and offline gates remain effective; the obsolete trial limiter stays removed. An offline stub cannot count as live acceptance.

## Verified starting point

| Source | Observed behavior and implication |
| --- | --- |
| `server/adapters/l10-limits.ts` (all 239 lines inspected) | Completion ladder `[1800,3000,6000,12000,24000]`; turn multipliers `[1,2,3]`; 84-turn, 250,000-token, 100-attempt/hour, 80-second/turn and 480-second/session constants. `nextPerTurnLimit` and `canReserve` are pure scaffolding; no production caller currently invokes them. |
| `server/adapters/l10-limits.ts:149` | `assertLiveAccountingGate(_env)` always throws. Its preceding comment about `AGENT_COMMONS_L10_ACCOUNTING=measured` contradicts the implementation. This variable must not become an accounting bypass. |
| Direct production gate callers | `server/cohort.ts:274`, `server/engine.ts:123`, `server/adapters/preview_bridge.ts:53`. All need an explicit disposition; changing the shared function must not accidentally open an unmetered entry. |
| `server/cohort.ts:181-211,213-256,388-445` | Probe catches errors into `adapter blocked`; success becomes `adapter ready`; summary feeds GET `/api/cohort`. Requests currently fabricate per-call run ids and fixed `{1800,2400,600}` limits/reservations rather than reserving shared run capacity. Present live validation permits null usage; provided usage must have safe nonnegative counts, `total=prompt+completion`, envelope evidence and internal-call coverage. |
| `server/adapters/types.ts` | Existing `AdapterUsage`, limits, reservation, actual-model evidence and exit/count/hash metrics provide the transport contract. Extend these rather than inventing an unrelated usage format. |
| `server/adapters/l10-cohort.ts` | Live CLI route has startup route resolution, model/witness gates and normalized usage. At the inspected baseline it did not consume `req.limits` or `req.reservation` to enforce the requested token bounds. Its Grok/release path currently also refuses dispatch. Removing the accounting throw alone cannot make this route available. |
| `server/cohort_bridge.py` | Legacy preview requests a fixed 1,800-token completion and returns text only. It provides neither complete usage nor evidence that hidden/internal consumption is bounded; it cannot simply be declared measured. |
| `shared/schema.ts`, `server/storage.ts` | Drizzle exposes `snapshots(id,data)` and `agent_keys(id,private_key,public_key)`. Storage has synchronous `transaction`, load/save helpers, WAL and permission protection. Read-only inspection of the local SQLite schema confirmed only these two tables, with no accounting/reservation tables. No table/key data was changed. |

These are source/schema observations. Route capability, total-token enforcement, provider usage completeness and turn-extension policy are not established by the current code.

## Work breakdown and effort

Sizes are relative engineering estimates, not elapsed-time promises: S about half a day, M about 1-2 days, L about 2-3 days. W1-W5 overlap in implementation; overall scope is L, roughly 5-9 engineer-days if a usable fully metered route already exists. A transport that cannot bound/report all consumption is an additional integration dependency, not hidden inside this estimate.

1. **W1 — Persistent run, reservation and consumption state (M).** Targets: `shared/schema.ts`, `server/storage.ts`, new `server/adapters/l10-accounting-store.ts`. Add the three tables below, additive initialization and transaction methods. Retain all existing snapshots, identity keys and permission protections. Plan a normal backup/restore boundary before applying any later schema change; this document applies none. Prove restart durability and two independent SQLite connections competing for the last capacity.
2. **W2 — Usage validation and reservation bounds (M/L).** Targets: new `server/adapters/l10-accounting.ts`, `server/adapters/types.ts`, `server/adapters/l10-cohort.ts`, usage normalization in `server/adapters/l10-witness.ts`. Reuse existing count/evidence validation, but make complete usage mandatory for measured settlement. Derive a proven prompt plus generated/hidden/internal-token bound from the actual route. Thread and enforce limits at the real request/CLI boundary. Byte counts and character/4 estimates are not actual token metering. Routes without a supported bound remain closed with a precise reason.
3. **W3 — Atomic admission and exactly-once settlement (L).** Targets: new accounting/store modules, `server/adapters/l10-process.ts` only for the minimal admission/spawn-outcome hook, `server/adapters/l10-cohort.ts`, `server/cohort.ts`. Create one stable server-owned run id, unique call/reservation ids and a durable reservation before dispatch. Preserve existing permit-before-reservation/spawn ordering and run-id ownership. Settle successful, failed, cancelled, stale-generation and crash-interrupted calls exactly once. Record consumption even if the UI generation was cancelled; do not discard a result before settlement. Never run destructive process mutants against the host.
4. **W4 — Completion and turn ladders (M).** Targets: `server/adapters/l10-limits.ts`, accounting module, `server/cohort.ts`, and `server/routes.ts` only if the accepted turn policy needs a validated request field. Wire the existing completion helper, persist streak/hold state and use its returned ceiling for the next reservation. Implement the turn-ladder policy using the owner decisions below; preserve token, time and attempt budgets. Neither a page reload nor a model-role change resets a run's counters.
5. **W5 — Replace the blanket gate and wire every entry (L).** Targets: `server/adapters/l10-limits.ts`, `types.ts`, `l10-cohort.ts`, `preview_bridge.ts`, `server/cohort.ts`, `server/engine.ts`. Replace the env-shaped check with a runtime-validated admission permit. Route cohort probe and productive calls through the same accounting owner. Direct CLI callers also require admission. Keep legacy Python/cohort/engine paths closed unless they satisfy the same bound, usage and settlement contract; never turn the shared assertion into a no-op. Preserve the offline path and existing model/witness/teardown guards.
6. **W6 — Correct comments and operator diagnostics (S).** Targets: `server/adapters/l10-limits.ts` header/R8 comment, `l10-limits.test.ts`, `server/cohort.ts`, optionally `client/src/CohortConsole.tsx` if existing diagnostic rendering cannot carry the new reason. Remove the stale measured-env claim and update tests describing it. Report accounting admission, exhaustion, uncertainty and genuine downstream errors separately; do not label an admitted-but-auth-denied agent ready. Reuse the existing API diagnostic shape and avoid unrelated UI redesign.
7. **W7 — Regression and bounded end-to-end evidence (M).** Targets: new `server/adapters/l10-accounting.test.ts`, `server/adapters/l10-accounting-store.test.ts`, existing limits/cohort/offline/C2 tests, and new `packages/agent-commons/test/l10-accounting.test.mjs` as the package-suite entry for the targeted accounting tests. Run the package suite once on Node 22.23.2 after implementation, retain the 433 prior passes and report the new count. Run targeted SQLite/process-recorder tests, then the single separately authorized live check described below. No credentials test or live provider call is authorized by this planning task.

## Persistence model

Use explicit rows for cross-connection uniqueness and conditional updates; do not store accounting as an unguarded read/modify/write of the cohort JSON snapshot. Proposals below follow current snake_case SQLite / camelCase TypeScript mapping. Integer amounts must be safe nonnegative JavaScript integers; SQL checks should reject invalid ranges and states, with matching validation at the boundary.

| Table | Proposed columns and constraints |
| --- | --- |
| `l10_runs` | `id TEXT PRIMARY KEY`, `kind TEXT` (`cohort`, `probe`, `engine`), `policy_version INTEGER`, `state TEXT` (`active`, `closed`, `exhausted`), `token_cap INTEGER`, `charged_tokens INTEGER`, `reserved_tokens INTEGER`, `base_turn_limit INTEGER`, `granted_turn_limit INTEGER`, `attempted_turns INTEGER`, `ladder TEXT`, `eligible_slots TEXT`, `excluded_slots TEXT`, `multiplier INTEGER`, `started_at_ms INTEGER`, `deadline_at_ms INTEGER`. No caller-supplied mutable cap. Store validated ladder state with versioned shape; keep its per-agent state under the shared run ledger. |
| `l10_reservations` | `id TEXT PRIMARY KEY`, `run_id TEXT REFERENCES l10_runs(id)`, `call_id TEXT NOT NULL UNIQUE`, `slot_id TEXT`, `runtime_model TEXT`, `state TEXT` (`reserved`, `started`, `settled`, `released`, `uncertain`), `prompt_upper INTEGER`, `completion_limit INTEGER`, `total_upper INTEGER`, `created_at_ms INTEGER`, `started_at_ms INTEGER NULL`, `terminal_at_ms INTEGER NULL`. Include a unique single-use call identity and checked legal state transitions. Runtime ids stay local, not in public logs. |
| `l10_attempt_window` | Singleton `id=1`, `started_at_ms`, `attempts`; atomic 100/hour admission counter seeded conservatively from the existing cohort window. The existing cohort attempt guard remains an additional protective bound for unsupported/offline attempts. |
| `l10_consumption` | `reservation_id TEXT PRIMARY KEY REFERENCES l10_reservations(id)`, `charge_kind TEXT` (`measured`, `conservative`), nullable `prompt_tokens/completion_tokens/total_tokens`, `charged_tokens INTEGER`, `usage_source TEXT NULL`, `usage_field_path TEXT NULL`, `covers_internal_calls INTEGER`, `outcome_code TEXT`, `metrics_json TEXT NULL`, `actual_model TEXT NULL`, `recorded_at_ms INTEGER`. One terminal receipt per reservation; metrics are only exit/count/hash, never raw streams, prompts, secrets or keys. |

Keep `charged_tokens` and `reserved_tokens` as transaction-maintained projections; compare them with reservation/receipt sums on recovery. A mismatch closes the run. Enable and test foreign-key enforcement explicitly if it is not already enabled. Add indexes on `(run_id,state)` for outstanding reservations and `(run_id,created_at_ms)` as needed; avoid a separate event system until required.

Do not put a SQL constraint on `charged_tokens < token_cap` that would reject a truthful overrun measurement. The admission predicate enforces the cap; if measured usage exceeds its reserved bound, persist the measured overrun, close the run and report the enforcement defect. Invalid/unrepresentable usage retains a conservative charge and uncertainty rather than fabricating a number.

Hourly attempts already live in the durable cohort budget snapshot. Update or reference that existing window atomically during admission so concurrent probes/productive calls cannot exceed it; do not create an independently resettable second allowance. The store API must receive the current attempt-window state within the same write transaction, or move that existing counter to one canonical row as part of W1 with an explicit compatibility migration.

## Proposed internal interfaces

These are design signatures, not implemented exports. Keep the accounting service private to the server and do not add a new public package API solely for this console. Construct the store with an injected SQLite connection; attach the production connection from the application boundary. Importing the pure accounting/store modules must not import the current `storage` singleton or open `commons.db`, so tests can use genuinely isolated databases.

```ts
type AccountingRunKind = "cohort" | "probe" | "engine";
type LadderState = {
  currentLimit: number; boostStreak: number; nonBoostStreak: number;
  hold: boolean; turnMultiplierIndex: number;
};
type AccountingPermit = object; // opaque at runtime; not a JSON token
type UsageObservation = {
  usage: AdapterUsage | null;
  metrics?: AdapterMetrics;
  actualModel?: string;
  outcomeCode: string;
};
type Settlement = {
  state: "settled" | "released" | "uncertain";
  chargedTokens: number; releasedTokens: number;
  duplicate: boolean; outcomeCode: string;
};

new L10AccountingStore(connection: AccountingDatabase);
new L10AccountingService(store: L10AccountingStore, options?: {now?: () => number});

createRun(input: {
  kind: AccountingRunKind; baseTurnLimit: number;
  policyVersion: number; nowMs: number;
}): AccountingRun;
loadRun(runId: string): AccountingRun | null;
reserveCall(input: {
  runId: string; callId: string; slotId: string; runtimeModel: string;
  promptTokensUpper: number; limits: AdapterLimits; nowMs: number;
}): { permit: AccountingPermit; reservation: AdapterReservation };
assertLiveAccountingGate(permit?: AccountingPermit): void;
markAccountingDispatchStarted(permit: AccountingPermit): void; // l10-admission.ts
settleCall(permit: AccountingPermit, observed: UsageObservation): Settlement;
releaseUnstarted(permit: AccountingPermit, reason: string): Settlement;
recoverInterruptedRun(runId: string, nowMs: number): AccountingRun;
// Complexity promotion is internal and automatic; no manual promotion event.
```

The permit must be checked against server-owned runtime state and its persisted reservation: correct run/call/slot/model, active deadline, legal state, bounded counters and single-use dispatch. A structurally similar object, env string, request-body field or reused permit is not proof of admission. Bind the actual request limits to the reserved row. `AdapterRequest` may carry an internal optional permit for fixture compatibility, but every live adapter must require and validate it; offline stubs must not mint or consume live permits.

Transactions must encompass the READ, capacity predicate, uniqueness claim, reservation insert and counter update, not just the final write. Use the current synchronous SQLite transaction support with the appropriate immediate-write semantics and bounded busy handling. Avoid optimistic helper-only math outside the transaction as the final admission decision.

## Admission, settlement and recovery rules

1. Validate route eligibility, exact model, cancellation, proven bounds and deadline. Acquire the existing live-process permit in its required order; then atomically reserve token/turn/attempt capacity before the external action. A reservation failure releases only the local process permit; no child starts. Bound waiting by the remaining session time.
2. Preserve the current strict exhaustion rule: `charged + reserved + requested < 250_000`; exactly 250,000 is refused. Validate every operand before calling `canReserve`; negative, fractional, unsafe or inconsistent amounts fail closed. `total_upper` covers the full prompt plus all allowed completion/hidden/internal calls, not only visible output.
3. Mark the dispatch boundary explicitly. If a crash occurs between spawn and its recorded acknowledgement, treat the call as possibly started. Do not infer zero consumption from a missing success result or from an HTTP/CLI failure.
4. On a valid complete observation, atomically compare-and-set the reservation to settled, insert its single receipt, subtract its whole reservation and add measured total usage to charged tokens. Only after that transaction may the result be published as available/ready and the next turn admitted. A repeated identical settlement is a no-op; a conflicting receipt is a terminal accounting error.
5. A proven pre-dispatch refusal can release its reservation with no token charge, retaining the attempt audit as appropriate. Post-dispatch timeout, cancellation, usage wall, auth error, malformed envelope, absent usage, missing internal-call coverage or lost process outcome must not automatically refund capacity. Owner policy: charge the full reservation, quarantine that agent and continue the run through deterministic handoff; retain the true downstream diagnostic. The run continues through handoff under the owner decision.
6. Preserve the existing `totalTokens === promptTokens + completionTokens`, safe-integer, source/field-path and coverage checks. Do not loosen them to accept provider formats silently; a provider whose hidden-token semantics differ needs an explicit normalization contract. A valid but over-bound observation is recorded truthfully and closes further dispatch.
7. UI cancellation/generation changes suppress stale display updates but never suppress settlement. Recovery loads the same run and outstanding reservations; it must not release them on a time-to-live, create a fresh budget on restart or replay an uncertain call. This slice proposes no automatic correction/reopening of uncertain receipts; later reconciliation needs explicit evidence and scope.
8. Storage failure before dispatch prevents dispatch. Failure after a possibly started call prevents the next call and preserves its reservation/uncertain status. Single-use terminal transitions and receipts must remain idempotent across retries of local bookkeeping, without retrying the provider request.

## Ladder policy: established rules versus open semantics

**Established completion behavior:** begin at the accepted initial ceiling (current scaffolding uses 1,800). Valid completions using at least 80% advance one step up to 24,000; two consecutive boosts set hold. While held, keep the ceiling unchanged; two consecutive valid below-threshold completions clear hold. Missing/invalid usage neither boosts nor clears a hold. Reuse `nextPerTurnLimit` rather than reproducing it in cohort code.

**Established outer caps:** at most 84 turns, 250,000 run tokens under the strict reservation boundary, 100 attempts/hour, 80 seconds/turn and 480 seconds/session. Pass `min(turnTimeout, remainingSessionTime)` to every productive call as the probe already does. Persist run deadline and counters. The obsolete process-wide trial limiter is removed; only ordinary run budgets apply.

**Owner-selected v1 rule:** use the deterministic available-signal heuristic in the owner-decisions section. The prior scaffold had no promotion event; this implementation supplies it automatically. The implementation reads only the documented available signals, computes `baseTurnLimit * [1,2,3][index]`, caps it at 84 and refuses promotion when token/time/attempt bounds would be violated. No event is supplied by arbitrary page input.

## Verification and acceptance

Implementation tests are isolated and fixture-only; no live probes or provider credential tests are authorized by this scope. Use scratch databases and fixture adapters/process recorders; do not let tests import the production singleton and write the live `commons.db`, use the shared process permit directory or run host-reaching kill/delete mutants.

| Work | Required proof after implementation |
| --- | --- |
| W1 storage | Fresh additive initialization; pre-existing snapshots/keys preserved; restart readback; missing/malformed policy version refused; two independent connections competing for the last capacity produce one winner; missing FK/transaction guard is detected by a one-property fixture. |
| W2 metering | Exact envelope counts/evidence accepted; missing/null/partial/negative/fractional/overflow/inconsistent counts and incomplete internal coverage rejected; prompt/system/wrapper/hidden-token bounds enforced at the actual transport boundary, with an over-bound fixture proving the check. |
| W3 settlement | Healthy reserve/start/settle; cap-minus-one fits and exact cap refuses; duplicate completion is not double charged; conflicting duplicate refuses; pre-spawn failure releases; post-spawn timeout/cancellation/auth/usage-wall/unknown outcome retains conservative charge; restart and stale-generation delivery never refund or replay. Assert the recorder's dispatched set and SQLite totals, not only exception text. |
| W4 ladders | Existing helper poles remain; exact 80% boundary, ceiling saturation, held boost and two-completion hold clearing; invalid usage leaves state unchanged; selected turn-policy events advance 1/2/3 once and stop at 84; budgets/deadlines survive restart. No obsolete trial limiter remains; more than seven valid calls are admitted when ordinary budgets allow. |
| W5 entry wiring | Cohort probe, productive loop, direct CLI adapter, legacy cohort call, preview bridge and engine bridge cannot dispatch without a valid permit. Offline tests remain offline. Missing permit, replayed call id, wrong slot/model or unsupported usage contract yields zero provider dispatch. Only metered paths are admitted. |
| W6/API | GET `/api/cohort` keeps the existing shape and records admission plus real downstream diagnostics; only a successfully validated and settled response becomes `available:true`/`adapter ready`. Ledger/identity state is retained. The stale env variable cannot admit an unaccounted call. |
| W7 regression | Run `npm test` in `packages/agent-commons` once on Node 22.23.2 after the implementation. All 433 prior tests stay green plus the new accounting entry. That `.mjs` entry should invoke the targeted server TypeScript accounting tests through the existing tsx loader in an isolated child with a scratch DB; it must not run the entire server/process harness or any live route. Targeted server/offline/C2 checks cover modified seams. Report counts and scope; do not rename fixture acceptance as provider success. |

For the requested live check, first finish the accepted source/fixture checks and obtain an exact bounded execution scope using an already configured eligible route; credential discovery/testing remains outside scope. Identify the run and reservation in the diagnostic so the UI result can be joined to its accounting receipt.

A future authorized live check must use one selected eligible metering-capable route and an explicit normal run budget. Do not change credentials or claim an offline fixture as a live check. No provider requests are made during implementation.

Pass evidence: at least one previously accounting-blocked slot traverses real admission and records either (a) a valid, settled response with `available:true`, or (b) an authentic downstream error such as route/witness/auth/provider denial, with a truthful released/conservative/measured accounting outcome. A downstream refusal demonstrates accounting-path reachability only, not readiness. A stub response, fabricated error or removed guard is not the requested evidence. A missing route bound remains a named implementation prerequisite rather than a reason to fake admission.

## Owner decisions — implemented policy

1. **Automatic project complexity, v1:** deterministic, monotonic multiplier. Requested base work of at least 14 turns starts at 2 and at least 21 starts at 3; otherwise start at 1. Proven prompt upper bound at least 6,000, any agent completion tier at least 6,000, or cumulative measured/conservative charges at least 25,000 promotes to at least 2. Thresholds 12,000/12,000/75,000 promote to 3. These are available work-size/context/consumption signals, not a claim of semantic project understanding. Granted turns are min(84, base turns times multiplier), subject to existing token/time/attempt caps. No manual multiplier input.
2. **Per-agent completion streaks and holds; one shared run budget.** All handoffs carry the same run counters, deadline and each agent's ladder state.
3. **Remove the obsolete process-wide trial limiter completely.** Remove its counter, environment switch, reset/bypass functions, allowlist entries and obsolete assertions. Ordinary requested work size and token/time/attempt caps remain; they are not a replacement trial limiter.
4. **Uncertainty does not close the run.** A possibly dispatched call with untrustworthy/missing usage charges its full reservation once, quarantines only that agent in that run, and hands the pending phase/task to the next eligible agent in founding-cohort order. Skip excluded, already failed and Prism/Terra slots; never replay the unknown call. Stop only when no eligible agent remains or ordinary turn/token/time/attempt budgets exhaust.

Implementation uses a runtime metering-capable adapter interface. No current route has proved full token bounds and complete usage; those routes remain refused until that capability exists. This is a reported integration gap, not permission to bypass the check or claim a live verification. Provider credential tests and Prism/Terra routing remain out of scope.

Other risks and corresponding tests: concurrent SQLite admission; failed storage writes; interrupted process outcome; unmeasured internal calls; wrong usage envelope; deadline changes; stale UI generations. Unit/fixture tests must use private in-memory/scratch databases and process recorders. Never run host-reaching destructive process mutants or touch the running console's database during tests.

## Implementation verification

- Owner decisions are implemented in the working tree; no commit was created.
- Package suite on Node22.23.2: 434/434 passed, zero failures/skips/cancellations. The new package test bridge separately reports 22/22 targeted accounting/SQLite assertions.
- Targeted cohort, accounting integration, offline adapter and engine suites:16/16 passed. TypeScript noEmit check: exit0.
- The original 433 package tests remain green. Trial-cap counter/environment/reset APIs are removed; regression tests assert their absence.
- Real transports do not yet declare/prove full metering and remain fail-closed. Live readiness and provider credential validity were not tested.
- PID49175 was not killed or restarted; a controlled later restart is required to load the new code, and cannot by itself supply a metering-capable route.

## Metered OpenAI Responses transport

Implemented `server/adapters/openai_responses.ts` and wired it as the default governance/Sol transport. Other slot routing is unchanged. The adapter uses the exact existing frozen governance model; no substitute model or fallback is introduced.

- Preflight: POST `https://api.openai.com/v1/responses/input_tokens` with the frozen inline-text/model/tools payload. The provider count, including message formatting, plus the completion ceiling forms the reservation. No character-ratio estimate or fabricated usage is used.
- Generation: POST `/v1/responses` with identical input-affecting fields and `max_output_tokens`; no tools, streaming, background task, conversation history, redirect or automatic retry. `max_output_tokens` includes hidden reasoning.
- A one-use quote binds prompt, model, completion ceiling and complete reservation. A real accounting permit is required before generation; dispatch is marked immediately before that request.
- Settlement reads `usage.input_tokens`, `usage.output_tokens` and `usage.total_tokens` from the provider response. Cache/reasoning detail counts are subsets, not additional charges. Evidence is labelled `provider-response`, not a CLI envelope. Invalid or over-bound usage is rejected; valid usage on an incomplete/wrong-model response is still attached for truthful settlement.
- Provider response bodies are bounded and never logged. Persisted diagnostics are exit/count/hash metadata and safe static error codes.

Activation names only: `AGENT_COMMONS_OPENAI_API_KEY` and explicit `AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED=1`. Missing key produces `CREDENTIAL_MISSING`; requests disabled produces `PROVIDER_DISPATCH_DISABLED`. These are runtime-only inputs, excluded from project file loading and child environments. This task does not inspect their values or any credential-bearing paths.

During the authorized console restart, provider requests remain disabled and the child receives only a public startup environment. The cohort probe is a local application check, not a provider or credential test. Missing-credential/disabled diagnostics are reported as observed, not as successful model dispatch.

Contract sources: [OpenAI token-counting guide](https://developers.openai.com/api/docs/guides/token-counting), [input-token endpoint](https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count), [Responses creation reference](https://developers.openai.com/api/reference/resources/responses/methods/create). These support exact count and output-token bounds; live credential validity, entitlement and the frozen model's API availability remain unverified.

This closes the missing transport-interface/metering implementation for governance. It does not claim real provider success: this task permits only fixture HTTP responses and a network-disabled local cohort probe. Other four previously accounting-blocked slots still require their own metered transport. Prism/Terra exclusions remain unchanged.

## Metered transport verification and restarted runtime

- Node22.23.2 package suite:435/435 passed,0failed,0skipped,0cancelled. The new Responses bridge runs18/18 fixture tests; the previous accounting bridge retains22/22. Targeted cohort/adapter/engine subset:19/19. TypeScript noEmit and diff whitespace check:exit0.
- At 2026-10-20 07:10:47 PDT, verified original PID49175 owned the authorized worktree and port5087, then sent SIGTERM. Started npm run dev with a public-only environment and provider requests explicitly disabled. New listener PID84391, npm parent84369, URL http://127.0.0.1:5087/. HTTP root returned200.
- One local POST /api/cohort/probe returned200; GET /api/cohort returned200 after completion. Sol/governance reports CREDENTIAL_MISSING. Mneme, Nexus, Forge and Aegis retain LIMIT_UNSUPPORTED for their unmetered legacy routes. Prism and Terra retain MODEL_UNAVAILABLE. Accounting charged/reserved/attempted-turn totals are0/0/0.
- No credential files, stores or existence checks were inspected, and no provider request was sent. Runtime missing-key reporting is an application diagnostic, not a credential-store audit. Provider entitlement/model availability and successful live settlement remain unverified. No commit was made.

## Anthropic and xAI provider extension

- `anthropic_messages.ts`: shared Anthropic Messages transport for Mneme/continuity, Nexus/collaboration and Aegis/security. Activation name: `AGENT_COMMONS_ANTHROPIC_API_KEY`. Uses exact frozen slot models, Models API `max_input_tokens`/`max_tokens`, one-use quotes, real permit and dispatch marking. Actual prompt usage includes uncached input plus cache-read/cache-creation counts; output includes thinking. No tokenizer estimate is called a hard bound.
- `xai_responses.ts`: xAI Responses transport for Forge/release. Activation name: `AGENT_COMMONS_XAI_API_KEY`. Uses exact model or its explicit metadata alias in `/v1/models`, documented `context_length`, tool-free single generation and measured usage. The generation model is never substituted. Text-only tokenization is not used to guess missing inference framing.
- `provider_http.ts`: shared bounded HTTP/error/cancellation/activation code; no redirects, retries, raw provider bodies in logs or extra tool calls. All HTTP routes retain `AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED` as explicit activation.
- `provider_credentials.ts` and `server/index.ts`: three scoped HTTP keys are captured once into private process-local storage before the general credential scrub. They are never re-added to console or CLI child environments. No credential files/stores are read by these modules.

Historical context-window proxies above were superseded by the owner-directed count-endpoint correction below; they no longer describe current admission. The underlying counter precision caveat remains explicit.

Primary contracts: https://platform.claude.com/docs/en/api/models/retrieve ; https://platform.claude.com/docs/en/build-with-claude/context-windows ; https://docs.x.ai/developers/rest-api-reference/inference/models ; https://docs.x.ai/developers/rest-api-reference/inference/responses ; https://docs.x.ai/developers/faq/billing .

The secrets custodian acknowledged the provisioning request at 07:23:44 PDT on 2026-10-20. At the single status check no reply/provisioning receipt was recorded. The request lists activation names only and asks the secrets custodian not to restart, so the implementation owner handles the single restart after tests. No provisioning completion is inferred from acknowledgment.

## All-provider runtime checkpoint

- 2026-10-20 07:29:02 PDT: verified and stopped PID84391, restarted the same worktree on127.0.0.1:5087. New listenerPID41366; npmPID41353. Exact scoped activation variables are forwarded opaquely by name; no credential values/presence lists are printed and no credential files are opened by the restart procedure.
- Root GET200; one POST/api/cohort/probe200; subsequent cohort snapshot completed with all five eligible slots CREDENTIAL_MISSING. Prism/Terra remain MODEL_UNAVAILABLE. Charged/reserved/attempted accounting totals0/0/0. This proves runtime route selection and fail-closed activation, not provider success or custody absence.
- Node22.23.2 package437/437; conditional Anthropic fixtures10/10, xAI fixtures14/14; integration/startup23/23; TypeScript noEmit and diff check exit0. Hypothetical small-context fixtures are not actual-model availability evidence.
- Provisioning readiness from the secrets custodian remains unconfirmed at the last checked request; acknowledgment is not a provisioning receipt. A restart notification is queued on that thread. A follow-up restart after provisioning must use the approved scoped-variable/launcher handoff. No commits or provider requests were made in this phase.

## Owner-directed provider-count correction and custody restart

Anthropic now POSTs `/v1/messages/count_tokens` with the same frozen model/messages/tools payload used for generation. Its returned `input_tokens` plus the requested output ceiling forms the reservation; the Models API context-window proxy is removed. All three frozen Anthropic slots share this implementation.

xAI now validates the slot model against the actual `/v1/models` catalogue shape and POSTs `/v1/tokenize-text` with that model and the prompt. The configured release literal is corrected from the absent build-fast identifier to `grok-4.7`. The returned `token_ids` list length plus output ceiling forms the reservation; catalogue context length no longer determines the reservation. Tokenizer JSON has its own bounded32MiB allowance; generation responses retain64KiB.

Precision margin: these are provider-reported preflight counts. Anthropic documents its count as an estimate; xAI documents additional inference framing beyond text tokenization. A200 response proves endpoint access, not an absolute hard upper bound for eventual generation input. The implementation does not fabricate padding or call these counts rigorous bounds; measured usage above the quote remains an accounting overrun. Actual generation under these counters remains unverified in this task.

The local cohort probe is now non-generative for real transports. It checks routing, activation, catalogue/count endpoints and budget fit, and emits `PREFLIGHT_OK`, status `preflight ready`, `available:false`, `preflightReady:true`, reported prompt count and reservation quantity. It never invokes generation, creates a live reservation or marks a provider dispatch. Productive generation still requires its own real accounting permit and settlement. Offline fixture responses remain explicitly labelled.

Restart procedure: after fixture/package/type checks, verify the current listener belongs to the authorized worktree, SIGTERM only that listener, and launch `<approved-custody-launcher> run -- npm run dev` in the same worktree. The approved custody launcher performs injection; the implementation owner does not inspect credential files, stores or values. Run one local cohort probe and report every status. No paid generation is authorized for this verification.


## 2026-10-20 07:49:12 PDT — provider-count correction verified

WHO: the implementation author. Served-by: exact root/delegated Codex models independently unprovable from logs.

KNOW: Node22.23.2 package suite437/437, zero failures/skips/cancellations. Included isolated Anthropic11/11, xAI16/16, OpenAI18/18 and accounting22/22 fixture cases; safe cohort/config/route subset21/21 and L10-cohort fixture1/1 also passed. TypeScript noEmit and git diff check exited0. Package log: `<scratch>/provider-counts-package-test.log`; typecheck log: `<scratch>/provider-counts-typecheck.log`. The optional L10-cohort fixture initially refused an inherited unrelated provider-key variable name; its documented clean fixture run passed. This was a fixture application-environment refusal, not a tool-hook denial; no credential values were read.

RUNTIME: requested PID41366 had already exited. The idle replacement listener58400 belonged to this exact worktree and127.0.0.1:5087; it was verified and SIGTERM stopped. First ownership-check script aborted before any signal because lsof resolved the address as localhost; numeric lsof confirmed the same listener. Relaunched the approved custody command `<approved-custody-launcher> run -- npm run dev`; launcherPID96313, node listenerPID96361. No credential files/stores were inspected. Root GET200, one POST/api/cohort/probe200, GET/api/cohort200. Probe response explicitly maxGenerationCalls0.

LIVE SNAPSHOT07:47:52PDT: Mneme/Sol/Nexus/Forge/Aegis each PREFLIGHT_OK, status preflight ready, available:false, preflightReady:true. Reported prompt count/reservation quantities: Mneme42/1842, Sol32/1832, Nexus42/1842, Forge26/1826, Aegis42/1842. Prism/Terra remain MODEL_UNAVAILABLE. Probe completed7/7, error:null, charged/reserved/attempted-turn accounting0/0/0. Evidence: `<scratch>/provider-counts-status-j6apglyz.json`. Runtime log: `<scratch>/provider-counts-custody-8yw1qpm1.log`.

WIDTH/NEXT: counting access, catalog routing and reservation arithmetic are verified; actual paid generation, final response usage/model identity and settlement against the live providers were not exercised. Provider-reported counts do not prove hard prompt upper bounds; the documented estimate/framing caveat remains. Productive generation remains subject to permits and overrun accounting. All changes remain uncommitted on ac7/L26-s7-c1c2-01a12dc3 at HEADbaae8adb94ce260a032e901d01a4a9c7134abede. No Prism/Terra work, commit, push or release. Owner owns any later generation verification/approval. Falsifier: a later source or runtime snapshot differs.


## Owner-authorized Prism and Terra activation

Prism's founding-cohort Google/Gemini3.8Flash declaration maps to frozen `gemini-3.8-flash`, using `GoogleGeminiAdapter` in `server/adapters/google_gemini.ts`. Activation uses `AGENT_COMMONS_GOOGLE_API_KEY`, or the explicit alias `AGENT_COMMONS_GEMINI_API_KEY`; Google has priority when both are supplied. Both scoped names are captured privately before the generic environment scrub and never restored to child environments. The shared `AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED=1` gate remains required.

Gemini posts a full `generateContentRequest` to `models/gemini-3.8-flash:countTokens`, reserving returned `totalTokens` plus the output ceiling. The one-use quote binds the full tool-free, single-candidate body. Productive calls require a real permit and dispatch marker. Actual `usageMetadata` accounts prompt/tool prompt plus candidates/thoughts with safe totals; cached counts are not double-charged. Model evidence comes from `modelVersion`. Over-quote usage is preserved in an accounting observation and rejected. Google's documented count example differs from eventual prompt usage, so this is a provider-reported count, not a proven hard input upper bound.

Terra's founding-cohort OpenAI/GPT5.6Terra declaration maps to frozen API model `gpt-5.6-terra`, confirmed by the live provider catalogue and exact model retrieval. The initial bare `gpt-5.6` mapping was incorrect (HTTP404/model_not_found); a successful count response alone did not validate the model. It shares `OpenAIResponsesAdapter` and `AGENT_COMMONS_OPENAI_API_KEY` with Sol, with separate slot-bound quotes. No Kimi/Qwen/GLM/OpenRouter substitution is made. Token counting uses the same Responses input body as generation; returned model and usage evidence remain mandatory.

All seven slots now enter the same accounting eligibility, ladder and handoff paths. The old explicit Prism/Terra slot/model deny set, accounting deny set and productive/legacy seam exclusions are removed. Unknown model/slot validation, missing-credential failures, unmetered legacy refusal and real accounting permits still apply. CLI argv support remains separate: these new routes use HTTP, not an invented Gemini/Terra CLI invocation.

Verification covers provider counts, malformed evidence, output/prompt overruns, missing activation, exact model/slot binding, real admission-dispatch-settlement fixtures, quote coexistence, and seven-slot preflight with zero generation/reservation/charge/attempted-turn accounting. Actual live generation and settlement remain unverified by owner scope. Runtime checkpoint follows after one approved custody restart.


## 2026-10-20 08:29:02 PDT — seven-slot numeric verification and custody restart
WHO: the implementation author. Served-by: exact root/delegated Codex models independently unprovable from logs.
KNOW: fresh Node22.23.2 package exit0,438tests/438pass/0fail/0skip/0cancelled; route/capture exit0,3tests/3pass/0fail/0skip/0cancelled; TypeScript noEmit exit0; whitespace check exit0. Only numeric output was emitted. Previously blocked verification files were not reopened.
RUNTIME: verified PID96361 working directory and127.0.0.1:5087 listener, SIGTERM stopped it, launched approved custody runner with npm run dev in the same worktree. Launcher29638; listener29662. Root GET200, one count-only probe POST200, cohort GET200. Provider generation cap0; completed7/7; shared accounting charged/reserved/attempted turns0/0/0.
LIVE08:28:00PDT: Mneme PREFLIGHT_OK42/1842; Sol PREFLIGHT_OK32/1832; Nexus PREFLIGHT_OK42/1842; Forge PREFLIGHT_OK26/1826; Prism TIMEOUT; Terra TRANSPORT_ERROR; Aegis TRANSPORT_ERROR. Counts are reported input/proposed reservation quantities, not charges. All available:false; first four preflightReady:true. No MODEL_UNAVAILABLE remains. Prism message: Provider request timed out; outcome may be unknown. Terra/Aegis message: Provider request failed; no retry was attempted.
EVIDENCE: <scratch>/seven-slot-live-ftf3ol4_.json,3353bytes,SHA25602fa8cd4273ee8887e2cd0c3c58245ee3e91e260c8d49e989bcc3978800705b8.
WIDTH/NEXT: route exclusion removal and live count-path access are verified; Prism/Terra/Aegis provider preflight remains unsuccessful. Network failure root causes and all live paid generation/model/usage settlement remain unverified. No credential-file/value inspection, commits, pushes or generation. All source changes remain uncommitted on ac7/L26-s7-c1c2-01a12dc3, HEADbaae8adb94ce260a032e901d01a4a9c7134abede. Owner/coordinator owns any further runtime connectivity investigation; no hidden provider retries performed. Falsifier: later source/runtime snapshot differs.


## 2026-10-20 08:39:32 PDT — seven-agent provider preflight verified
WHO: the implementation author. Served-by: exact root/delegated Codex models independently unprovable from logs.
DIAGNOSIS: OpenAI model catalogue HTTP200 omitted baregpt-5.6; exact retrieval returned HTTP404/invalid_request_error/model_not_found while counting incorrectly appeared healthy withHTTP200. Catalogue exposes gpt-5.6-terra; exact retrieval HTTP200/idmatch. Frozen Terra mapping corrected in server/adapters/l10-routes.ts30. OpenAI bounds now GETs its exact model before counting at openai_responses.ts48, refusing404/mismatchedIDs without counting/generation. No model substitution.
PRISM/AEGIS: unchanged count endpoints returned HTTP200 in259ms/328ms during sanitized boundary reproduction; no source routing regression found for Aegis. The earlier underlying timeout/network cause was not retained by old diagnostics and remains UNVERIFIED; no speculative timeout increase or endpoint change. New provider_diagnostics.ts46/59 and provider_http.ts40/57 preserve HTTPstatus and allowlisted provider enums/network causes, never provider free text, request bodies, headers or exception strings. Error bodies capped4096bytes; no retries. Aegis seven-slot exact-route/count-only regression in anthropic-messages.test.ts71.
CHECKS: Node22.23.2 fullpackage exit0,439tests/439pass/0fail/0skip/0cancelled; targetedintegration exit0,24tests/24pass/0fail/0skip/0cancelled; TypeScript noEmit0 and whitespace check0. New diagnostics20/20, OpenAI25/25 fixtures included through package bridges. Only numeric summaries emitted; old blocked logs not read.
RUNTIME: verified oldPID29662 and SIGTERM stopped it; approved custody launcher60815/new node listener60849 at127.0.0.1:5087. RootGET200; one count-only probePOST200; finalcohortGET200. Snapshot08:38:19PDT completed7/7/errornull. Every agent PREFLIGHT_OK/preflightready/preflightReady:true/available:false: Mnemeclaude-fable-5-1 42/1842; Solgpt-6.1-sol32/1832; Nexusclaude-opus-5-5 42/1842; Forgegrok-4.7 26/1826; Prismgemini-3.8-flash27/1827; Terragpt-5.6-terra32/1832; Aegisclaude-sonnet-5-5 42/1842. Counts are reportedinput/proposedreservation, not charges. Charged/reserved/attemptedturns0/0/0, no generation.
EVIDENCE: <scratch>/boundary-fix-live-_31hnhjc.json,3541bytes,SHA25600fc54a7e517e3759659b4a58f9ee7885f1664198fb925423080ad90e255503a. Boundary probes <scratch>/preflight-boundary.mjs, <scratch>/openai-model-check.mjs, <scratch>/terra-catalog-match.mjs, <scratch>/terra-model-exact.mjs emitted sanitized metadata only.
WIDTH/NEXT: all seven provider counting paths now verified; live generation, returned generation model/usage and settlement remain untested and outside this task. Provider-count precision caveats remain. No credential-file/store inspection, commits, pushes or releases. Worktree remains ac7/L26-s7-c1c2-01a12dc3 atHEADbaae8adb94ce260a032e901d01a4a9c7134abede. Owner/coordinator owns later generation testing; no preflight blocker remains at this snapshot. Falsifier: later source or runtime differs.


## 2026-10-20 19:57:09 PDT — one authorized Sol generation settled successfully
WHO: the implementation author. Served-by: exact root/delegated Codex models independently unprovable from logs.
AUTHORITY/PATH: owner authorized exactly one Sol/governance paid generation. Added strict empty-body POST/api/cohort/sol-generation-check at server/routes.ts27 because existing start fans out tootheragents. Durable atomic one-use guard owner-sol-generation-check-v1 in cohort.ts106 prevents retry/replay acrossinstances/restarts. It calls existing callForSlot -> real bounds/reserveCall/permitassertion -> OpenAIadapter -> finallysettleCall. New fresh run permits governance only, base turnlimit1, completionceiling16; per-call lowercap doesnotlower the ladder. No other generation path invoked and no retry.
BASELINE: live state had changed since08:38: prior run started14:43:06PDT had14startedcalls/69976chargedtokens; Solalready available:true/OK with2priorcalls/6489tokens. This task preserves that history and proves additional-call deltas, not false historicalzeros.
LIVE RESULT19:55:00PDT: reply PONG; actualModelgpt-6.1-sol; codeOK. Before dispatch: real reservationstate reserved, startedAtMsnull, permitAssertedtrue, inputbound13+outputceiling16=29reservedtokens; runreserved29. Provider usage: input13/output6/total19; cached0/cachewrite0/reasoning0. Durable receiptsettled/OK, charge19, release10, remainingreserved0, overrunfalse. Read-only SQLite receipt and subsequent GET/api/cohort independently matched.
IDENTIFIERS: run, call and reservation ids are kept locally only. New checkrun attemptedturns1, eligibleSlots[governance], charge19/reserved0. Globalafter15startedcalls/69995chargedtokens; governance3calls/6508tokens. Mneme/Nexus/Forge/Prism/Terra/Aegis each delta0generationcalls/0tokens; all prior totals and diagnostics unchanged, including Forgepre-existingPROVIDER_ERROR. Sol remains available:true/OK, usageValid:true, actualModelgpt-6.1-sol, one-shotcheckcomplete.
VERIFICATION: Node22.23.2 package440/440pass0fail0skip0cancelled; targetedregressions21/21; TypeScript0/diffcheck0. New isolatedSol4/4, accounting25/25 andOpenAI26/26 fixturecases pass. Real usage shape was covered; no source changed after the paid call, so no redundant full-suite rerun. Outputs numeric-only; blocked logs not opened.
RUNTIME/EVIDENCE: verified/stopped60849, custodylauncher74302/listener74366 at127.0.0.1:5087. RootGET200, exactlyone checkPOST200, finalcohortGET200. Safe full report <scratch>/sol-live-result-7cn77svm.json,4321bytes,SHA256091d5451e0242589895ecd0417a7c4144af81fbd7b64edbac972c3f834a1cd00. Single-use execution authority SPENT; application guard complete. Only reply PONG and numeric usage/accounting were retained, no headers/providertext bodies.
WIDTH/NEXT: live admission -> provider dispatch -> measured usage -> durable exactly-once settlement is proven for this single Sol check. Other six incurred no new calls/charges from this task; their prior activity is not attributed to this authorization. No further generation authorized by this check, no credential-file inspection, commits/push/release. All source remains uncommitted on ac7/L26-s7-c1c2-01a12dc3 atHEADbaae8adb94ce260a032e901d01a4a9c7134abede. Owner/coordinator owns any next work; no remaining gap in the requested Sol settlement proof. Falsifier: persisted receipt/API snapshot differs.


## 2026-10-20 20:17:23 PDT — Forge/xAI replaced by Argon/Gemini in active release slot
WHO: the implementation author. Served-by: exact root/delegated Codex models independently unprovable from logs.
CURRENT ROSTER: seven active agents; release is now Argon/Google/Gemini4Argon (shared/cohort.ts5), frozen gemini-4-argon (l10-routes.ts28), historicalidgemini_4_argon. Retained release slot, role identity and audit history. New profile docs/agents/argon-agent.md; former release-agent.md untouched as archive. Historical xAI-model feed entries display Historical release agent so they are not relabelled Argon.
DISCONNECTION: release/integration defaultgoogle-gemini at config.ts136-137; xai-responses removedfrom active registry and publicexports. Archived xai_responses.ts/tests remain independently pinnedgrok-4.7 rather than borrowing the active Gemini literal. HTTP-only release now refuses CLI argv without old Grok-route assertions. No old receipts/model evidence rewritten.
MODEL EVIDENCE: live GET/v1beta/models HTTP200,2pagescomplete, includes models/gemini-4-argon with countTokens/generateContent. Exact GET/v1beta/models/gemini-4-argon HTTP200/name match; countTokens HTTP200/57tokens,0generation. Reproinstrument <scratch>/argon-exact-model.mjs; no headers/keys/providertext output. Activation AGENT_COMMONS_GOOGLE_API_KEY or AGENT_COMMONS_GEMINI_API_KEY, shared AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED gate.
TRANSPORT: GoogleGeminiAdapter google_gemini.ts25/35 shares one implementation with per-slot exact-model quotes for integration and release. Permits, model evidence, prompt/output usage/thoughts/cache checks and settlement retained. FixtureArgonadmission/dispatch/settlement/overrun/missingcredential/isolation/replay covered; realgeneration remainsunverified and notauthorizedinthischange. Existing admission margin unchanged: server-local permit API validates liveness, while the cohort constructs matching slot/model requests and transport quotes enforce their exact values.
TESTS: Node22.23.2 package440/440 exit0/0fail/0skip/0cancelled; roster/cohort subset21/21; Google11/11 and archivedxAI16/16fixtures. TypeScript0/diffcheck0. Ancillary24casebatch had23pass/1legacyGrokmessageassertfail; updated that HTTP-only route expectation, reran the affected route fixture1/1pass/exit0. The23unchanged cases remainpassing; packageproductiontreeunchangedafter440pass. Numeric-onlyoutputs, no logbodyreads.
RESTART: verified/stopped74366, approved custodylauncher4557/newlistener5493 at127.0.0.1:5087. RootGET200; one count-only probePOST200; cohortGET200. Captured20:15:03PDT completed7/7/errornull: Mnemeclaude-fable-5-1 42/1842; Solgpt-6.1-sol32/1832; Nexusclaude-opus-5-5 42/1842; Argongemini-4-argon57/1857; Prismgemini-3.8-flash27/1827; Terragpt-5.6-terra32/1832; Aegisclaude-sonnet-5-5 42/1842. All PREFLIGHT_OK/preflightReady:true/available:false. Counts are reportedinput/proposedreservation, notcharges. Forge/xAI activecount0; rostercount7.
NO GENERATION: accounting calls15/started15/charged69995 before AND after, delta0/0/0. New probe charged/reserved/attempted0/0/0. Spent one-use Sol applicationguard stillcomplete; no Sol-checkendpointrequest or authorityreset.
EVIDENCE: <scratch>/argon-roster-live-zpkd1mww.json,3809bytes,SHA2561228132eda2b9b85faa71274b187f0437973bf4ddfecc7cb9de62ae04c494897.
WIDTH/NEXT: live catalogue/model/count access and active seven-agent roster are verified; Argon generation/modelVersion/real usage settlement unverified under this preflight-only scope. Prior accepted accounting pins, history and Sol receipt retained. No credential-file/store inspection, commits, pushes or release. Branch ac7/L26-s7-c1c2-01a12dc3 HEADbaae8adb94ce260a032e901d01a4a9c7134abede remainsuncommitted. Owner/coordinator owns any nextwork; this rosterchangecomplete. Falsifier: later source/runtime differs.


## 2026-10-24 18:32:49 PDT — pre-deploy B1/B2/B4/B5 fixes ready for independent review
WHO the implementation author. Served-by: exact root/delegated Codex models independently unprovable from logs. Owner confirmed earlier paid starts; no paid-generation investigation or new paid call is part of this task. Branch ac7/L26-s7-c1c2-01a12dc3 remains at86b4c755b4cddf09cf9df36d8976f3cfb4d05084; fixes are uncommitted.

B1: removed seven server-dependent bridges from portable package/test and retained seven coverage groups in server/provider-fixtures.test.ts, picked up by existing CI root glob. No workflow, dependency or package script changes. Isolated package-only npmci0/test433pass0fail; npmpack0; freshconsumer install0/test433pass0fail; dryrun has0server-starting tests; roottsxresolution unavailable in both isolated environments. Tarball <scratch>/uuaid-agent-commons-0.2.0-alpha.2.tgz SHA256b57a3b20bac99eadb1df59aeac44191ea1677bd454c8af2971fbd2e13df6907c. Evidence <scratch>/verification.json SHAb62e2d9e0d185731775b65903b0d67c32411a236b43f1a86663c593289683562.

B2 boot decision: retain exactly one pre-scrub private capture, explicitly allowed by D3 rather than silently weakening startup. The capture module imports nothing; AST/purity negatives enforce the five existing provider names plus the exact existing operator name, no arbitrary environment reads, files, network or application initialization. Operator value stays in a private closure, never restored to console/childenv. Static application-import mutant still fails. R3/R7 use current generation and explicit fixtures; R7 obtains and marks real memory admissions before usage/model assertions. registry-l10 now proves xAI absent.

Full adapter verification exposed an additional harness issue: generated fixture shell interpolated undefined JavaScript SEAT_TOKEN. Corrected one interpolation to shellvariable in packages/agent-commons/scripts/l10-twopole.ts296. Its test now pins childNode22 and redirects both parent/child userInfo homes to scratch configs; all refusal assertions retained. Initial verification reached the old real-home config-digest code path; no values or body output were emitted. Final runs use scratch homes. G1 mock-PID mutants use nonforwarding recorders, real forwarders target spawned fixtures; R4 group-kill mutant creates its own session.

B4: all API mutations require AGENT_COMMONS_OPERATOR_TOKEN in every environment; missing=>503 OPERATOR_UNCONFIGURED, invalid=>401. Fixed-length SHA256 digests use timingSafeEqual. Valid Origin is also required. Host policy precedes parsers/routes/Vite/static and rejects foreign WebSocket upgrades. Defaults are127.0.0.1/localhost/[::1] atactualport; AGENT_COMMONS_ALLOWED_HOSTS canextend exact authorities. ForwardedHost ignored. Newhost controls are process-only, not dotenv or CLI-child controls.

B5: AGENT_COMMONS_SOL_GENERATION_CHECK_ENABLED defaults off; route notregistered, and API guard ensures404 rather than Vite fallback or authentication. Enablingstillrequiresoperatorauth+Origin and reaches the real durable spentguard. Fresh memory-DB and claimed-guard fixtures prove0dispatch/0accountingcalls. Existing real guard and a stale run were not manually read or edited.

FINAL VERIFICATION Node22.23.2: fullroot70/70pass/exit0; directadapter136/136pass/33files/exit0; package-only433/433/exit0; coldinstalled433/433/exit0; Python6/6/exit0; TS5.6.3 noEmit0; diffcheck0. No skips/cancellations/failures in final test runs. Numeric-only outputs; no old log-body reads. An initial numericcollector typo was corrected before recording the final measured totals.

RESTART: verified/stopped PID5493, approved custody launcher87501/newlistener87521 at127.0.0.1:5087. Live18:29:32PDT: rootGET200; ViteclientGET200; localhostGET200; foreignHostGET403/POST403 HOST_FORBIDDEN; unauthenticatedstartPOST with empty invalid-dispatch body503 OPERATOR_UNCONFIGURED; disabledSolPOST404. No authenticated or dispatch-capable paid POST sent. Runtime operator token is unavailable; custody contents were not inspected. the secrets custodian must provision the existing AGENT_COMMONS_OPERATOR_TOKEN.

Evidence <scratch>/blockers-live-check-ogudxma7.json. Final rootcounts <scratch>/root-numeric-result-8ozsgx0f.json; adapters <scratch>/adapters-numeric-result-3zco1pz5.json. Existing CI includes server/*.test.ts and the new bridge, but no job directly runs all server/adapters/*.test.ts; that gap is reported, workflows unchanged as requested.

WIDTH/NEXT: fixed working tree is ready for independent security and verification reviews, not release approval. No commit, push, tag, publish or deploy. No direct credential-file or real-database inspection. Real valid-token mutation and browser HMR behavior were not exercised; fixture auth/upgrade controls and real ViteclientGET were checked. Review fingerprint is generated after this documentation update, with separate hashes for new untracked test sources. Owner/moderator owns reviewer dispatch and any later ship decision. Falsifier: diff/untracked hashes or runtime checks differ.


## 2026-10-24 20:41:53 PDT — final operator UI, CI coverage and direct-entry isolation
WHO: the implementation author, with delegated CI, UI and test-isolation workers. Served-by: exact Codex models independently unprovable from logs.
KNOW: reviewed baseline HEAD86b4c755 and diff f347baaece26154ecc68a92a62c9744a335eebd1db30586a300caae137f8a29b matched before this revision, as did both previously untracked source-test hashes. Prior B1/B2/B4/B5 fixes remain included.
CI: the root job now explicitly disables provider requests, preserves the offline-home preload, and serially executes both server/*.test.ts and server/adapters/*.test.ts. The exact workflow command ran 212/212 tests, 0 failures/skips/cancellations, exit0; all 33 adapter files separately ran136/136, exit0. This closes the previous missing-adapter coverage condition.
UI: client/src/lib/operatorToken.ts holds the operator token only in private module memory. The password field disables autocomplete; saving clears the draft, no saved value is rendered, and Clear removes both drafts and the private value. The same-origin request builder sends Bearer authorization only on mutations, including Start/Pause/Probe/Import; GET queries/exports carry no token. Requests refuse external paths and redirects. Static errors distinguish401,503 OPERATOR_UNCONFIGURED and generic503; arbitrary server bodies are not displayed. No new client harness/dependency was added: four root contract/server-render tests exercise the actual client request builder against the actual operator/Host guards, verify token-free GETs, and verify saved-token absence from rendered markup. Node fixture fetch adds only the browser-automatic Origin header; browser execution itself remains unverified.
R7: server/adapters/l10-r7.test.ts now exits64 before Cohort/storage imports when run outside node --test; under the runner it installs the offline preload itself. Two entry-isolation tests compare guarded direct entry with an unguarded control using a DB-module-resolution recorder that cannot open any database. Direct R7 recorded0 DB resolutions, while its blocked control recorded1. Test-runner R7 without external NODE_OPTIONS passes with0 DB resolutions. No live database was read or changed.
VERIFICATION: Node22.23.2 combined CI212/212 exit0; direct adapters136/136 exit0; client contract4/4 exit0; entry isolation2/2 exit0. Isolated package-dependencies-only install0/tests433/433 exit0; npm pack0/coldinstall0/installedtests433/433 exit0; dry-run server-dependent test count0. Python bridge6/6 exit0. Pinned TypeScript5.6.3 noEmit0; client build0; full CI production build0; whitespace0. Numeric summaries only; no old log bodies were opened.
EVIDENCE: combinedCI <scratch>/exact-ci-counts-_lq0tkoo.json; adapters <scratch>/adapters-numeric-result-2wzjvkn2.json; portable/cold/Python <scratch>/verification.json.
WIDTH/NEXT: source verification is complete for this revision; PID87521 is intentionally left running without a restart, provider calls or authenticated live mutations. the secrets custodian owns custody provisioning of AGENT_COMMONS_OPERATOR_TOKEN. This revision is authorized for one local commit only; push/tag/publish/deploy are not authorized. The moderator owns the subsequent custody restart, independent security and verification review and UUAID web ship disposition. Falsifier: later source/runtime state differs from the final commit or recorded checks.
