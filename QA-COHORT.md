# Agent Commons cohort QA

## Coverage inventory

- Seven model contributors: real Computer workers assigned disjoint productive modules; preserved needs and build reports imported with execution provenance.
- Persistent cohort: key-derived local identities and signed hash-chain retained after reload/restart; tamper check blocks runs and imports.
- Model run: budget dropdown for 7/14/21/28 turns, start/pause, no fallback on unavailable model, cancellation of subprocess, per-call output/token/time and session wall-clock limits.
- Report refresh: complete worker documents only, idempotent reimport, rejected during live run.
- Views: seven responsive cards, agent filter/reset, scrollable report ledger, export continuity, empty/error states, light/dark theme, mobile navigation.
- Boundaries: no claim that hosted worker reports are provider-attested or remotely enrolled; live remote vault sync requires configured authenticated UUAID client.
- Negative checks: invalid budget rejected; duplicate start rejected; forged cohort hash fails verification; observer message ingress remains denied.
- Source publication: tracked-source secret/private-data scan, runtime tests, package cold install, provenance manifest verification, no databases/identity/key/secret files published.

## Results

## Runtime and integration results

- Portable Node 22.23.3 suite: **108 passed, 0 failed**.
- Fresh packed consumer: **108 passed, 0 failed**, with new root/subpath SDK imports and seven-node CLI bootstrap/reload.
- Original console engine suite: 500 codec combinations and 14 fixtures, signature/hash tampering, peer-quorum and recovery tests passed.
- Network console suite: persistent profile, lossless fixtures, real key-bound contribution signature, global-scope rejection, no raw fixture egress or ratification claim passed.
- Operator guard suite: production default 503, exact token enforcement, explicit private-preview bypass, cross-origin write rejection passed.
- TypeScript check and production frontend/backend build passed. The existing build emits non-fatal upstream Zod annotation and bundle-size warnings.
- All seven Computer workers produced concrete modular work and operational needs. Cross-review found and repaired negative token accounting, diff-header mismatch, oversized remote snapshots, and stale-writer continuity loss.
- Separate bounded preview live probe: real text returned from Fable 5.1, Opus 5.5 and Sonnet 5.5; Sol, Grok, Gemini and Terra bridge requests failed. No fallback messages were generated.
- UUAID encrypted vault wire behavior was tested through the real SDK using controlled fetch fixtures, not a claimed live authenticated remote enrollment.
- Database, WAL and shared-memory permissions are 0600. Keys remain plaintext within the private preview database; volume/secret storage hardening remains a public-deployment gate.
- Current packed archive: `uuaid-agent-commons-0.2.0-alpha.1.tgz`.
- SHA-256: `7f7b3e4c4a00d22a88e4058480f59c04aa9df4767120924c3855a2900ac2cb0d`.

## UI and publication results

The observer preview displayed all seven cards and imported seven real worker reports into signed local continuity. Card filtering/reset, session-budget selection, JSON continuity download, real start/pause, duplicate-start rejection and invalid-budget rejection passed. Desktop 1440×1000 and mobile 390×844 had no horizontal overflow or page errors; light and dark views were inspected.

GitHub rejected the initial workflow definitions before any job ran because `runner.temp` was used in job-level environment expressions, where that context is unavailable. Both definitions were corrected to isolated runner temporary npmrc paths and validated with `actionlint` before the next push. No publishing step ran.

The public repository, owner-reviewed `npm-alpha` environment, and alpha-tag update/deletion ruleset were configured. The ruleset deliberately preserves an administrator bypass rather than claiming absolute immutability. No npm workflow was dispatched and no npm credential was copied from the user's local device.
