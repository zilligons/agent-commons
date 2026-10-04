# Agent Commons Security Review: portable runtime and planned seven-agent cohort

**Reviewer:** independent safety reviewer (read-only review; no code changed).
**Date:** 2026-10-04. **Commit reviewed:** `f8b9150` plus untracked `docs/` (SOP and `docs/agents/sustainability-agent.md`).
**Status:** point-in-time review of source. Nothing was executed against the network. No external writes, no commits.

Scope reviewed: `packages/agent-commons/src/{runtime,trust,carrier,store,config,loop,profiles}.mjs`, `bin/agent-commons.mjs`, `profiles/*.json`, `examples/*`, reference console `server/{index,routes,network,storage,engine}.ts`, `server/model_bridge.py`, and the two new docs.
Not reviewed: the seven agents' code. **None existed in the workspace at review time** (only `sustainability-agent.md` and the SOP). Section 6 is the gate each agent must pass when code lands; this review does not certify any of them.
Not reviewed in depth: vendored Pillar modules (byte-identical copies per `PROVENANCE.json`; upstream issues are out of scope). Pillar `open()` and `decrypt()` were treated as correct.

"Preference" below means an operational, model-generated priority used for scheduling. It is not evidence of sentience or standing, and no control here depends on that question.

Line refs are `file:line` as of the reviewed commit. Paths are relative to `packages/agent-commons/` unless prefixed `server/`.

---

## 1. Summary

The portable runtime is carefully built on its core: key-bound UUAIDs (`trust.mjs:27-28`), per-capability admission (`trust.mjs:31`), signed and canonical documents (`profiles.mjs:75-87`), alias-only self-modification (`profiles.mjs:66-74`), a lossless gate, fail-closed audit check (`runtime.mjs:12`), and bounded sizes and rates. The weaknesses are mainly around the edges:

1. The reference console is unauthenticated, binds 0.0.0.0, stores private keys in plaintext in a world-readable DB, and can spend provider credits and sign as an agent on anonymous requests. **Blocker for any non-loopback deployment, including zilligon.com.**
2. Sybil resistance is only per-UUAID-string, not per-key or per-operator. Quorum 2 is satisfiable by one operator.
3. "Metadata-only" contributions and profile proposals leak private fixture content (lexicon phrases, unsalted fixture hash, full fixtures inside proposals).
4. No cross-agent budget exists in the runtime. The spec (SOP section 4) describes envelopes that nothing enforces.
5. Inbound messages are permanently dropped on transient trust-backend failure.
6. The default credential onboarding puts the keychain passphrase next to the keychain.

**Verdict:** the portable runtime is acceptable for private, loopback or single-operator local use today. It is **not** ready for a seven-agent cohort with autonomous model-driven loops, or for public zilligon.com carrier operation, until the Blockers in section 2 are closed.

---

## 2. Blockers (must close before cohort activation or any public bind)

### B1. Console API is unauthenticated, publicly bound, and has a signing oracle
- `server/index.ts:214-219` listens on `0.0.0.0`. No auth middleware anywhere in `server/routes.ts`.
- `server/routes.ts:67-75` `POST /api/start` launches live provider calls (credit spend). It is repeatable with no cooldown or cumulative budget. The per-call `limit` max is 12 (`routes.ts:9`, `engine.ts:350-367`).
- `server/routes.ts:35-45` with `server/network.ts` `prepare()` signs a "profile-contribution" with the **atlas** private key for any anonymous caller (the `prepare` function loads `identity("atlas")`). This is a signing oracle for a real agent key.
- `server/routes.ts:20-34` creates profiles without limit (storage grows; snapshot is rewritten wholesale on each save, `server/storage.ts:30-37`). `/api/fault`, `/api/reprobe`, `/api/verify` and `/api/export` are open.
- **Fix:** bind `127.0.0.1` by default. Require an operator token (constant-time compare, env-supplied) on all mutating routes. Remove or gate `prepare()` so it signs only via an operator-approved action. Add a global live-spend ceiling persisted in storage (per hour, per day) and a 429 once it is reached. Keep `/api/export` behind the same token.

### B2. Private agent keys stored in plaintext in a world-readable database
- `server/storage.ts:11` (table `agent_keys` with `private_key TEXT`) and `storage.ts:59-70` store PEM private keys unencrypted. `commons.db` is mode **0644** on disk (observed), and WAL/SHM files are alongside it. `.gitignore` excludes `*.db`, but the `dist/` and handoff bundles must be checked too.
- **Fix:** `chmod 600` and `umask 077` at open. Move the console keys into the Pillar encrypted keychain (`src/vendor/pillar/identity/keychain.mjs`) with an operator-supplied passphrase. Rotate the existing keys (atlas, lyra, orion, sentinel) because they have been readable by other local users. Treat any exported `commons.db` as secret.

### B3. Sybil resistance counts UUAID strings, not keys or operators
- `runtime.mjs:56` blocks self-vote by `p.author===body.issuer`, and duplicate vote by `Object.hasOwn(p.votes, body.issuer)`. Both compare the UUAID string.
- `trust.mjs:27` accepts any namespace (`uuaid:[a-z0-9-]+:agent:<hash>`) and `trust.mjs:28` only checks the hash segment. One key therefore has many valid UUAID spellings (`uuaid:foundation:agent:X`, `uuaid:foo:agent:X`). If an operator admits both (or global registry resolves both), the same key can author a proposal and approve it, or vote twice.
- Even with distinct keys, `quorum` defaults to 2 (`profiles.mjs:47`, min 2 at `:51`). With author excluded, two sock-puppet keys of one operator reach quorum. `docs/AGENT-COMMONS-SOP.md` section 6.1 admits this honestly, but nothing in code surfaces it.
- Operators also hold `commons:evolve` for the init identity by default (`config.mjs:24`: every capability including `commons:recover`).
- **Fix (code):**
  1. Key votes, authorship and blocks by `publicKey`, not UUAID string (`runtime.mjs:48-56`, `trust.mjs:29`).
  2. Pin the namespace (`foundation`) or have the policy list exact UUAIDs only (already true) but also reject two policy entries sharing a `publicKey` at load.
  3. Add an optional `operatorId`/`independenceGroup` field to each policy agent binding. Count distinct groups toward quorum. Default every agent without a group to its own unique group, but print a `sybilWarning` in `status()` when fewer than quorum distinct groups exist.
  4. Raise the recommended cohort quorum to at least 3 distinct groups for `tenant` scope.
- **Fix (policy):** the seven cohort agents are likely one operator and likely one or two model providers. Do not describe their agreement as independent review. Record that in each review packet (SOP section 6.1 already asks for it).

### B4. Cohort has no runtime-enforced budget (loop and send paths)
- `src/loop.mjs:2-3` bounds `maxTurns<=100` for a single loop invocation only. Nothing counts model calls, bytes, spend or wall-clock. Nothing limits restarts of the loop. `turns` counts only received packets and spontaneous actions.
- `loop.mjs:13`: every received packet triggers a reply to the sender. Two agents in this loop can ping-pong indefinitely across loop restarts; there is no thread depth, per-peer rate or TTL.
- `loop.mjs:19-20`: `spontaneous` returns an arbitrary action object passed straight to `runtime.send` (recipient, `kind`, `namespace`). A model-controlled value can pick `kind:"profile-control"` and any admitted recipient. `runtime.send` only caps body size (`runtime.mjs:106`) and `broadcast` caps recipients at 32 (`:119`).
- The SOP `resourceEnvelope` (SOP section 4) and the sustainability agent's `expiresAt: required` have no implementation. "May not self-renew" is unenforceable if the agent holds the same process and DB.
- **Fix:** add `src/budget.mjs`: a persisted meter in the store (`kv`) keyed by agent and `cycleId` with `maxTurns`, `maxModelCalls`, `maxBytesOut`, `maxRecipients`, `maxSpend`, `expiresAt`. Charge before the action, refuse when exhausted, and write a refusal event. Issue the envelope from a different process or key than the agent that consumes it (signed by a `commons:budget` issuer; the consumer can verify but not mint). Add `maxDepth` and per-peer replies per hour to `runAgentLoop`. Restrict `spontaneous` output to a whitelist (`kind==="message"`, recipient in the policy, a known thread).

### B5. "Metadata-only" contribution and profile proposals leak private fixtures
- `profiles.mjs:90`: the metadata-only contribution includes `lexicon` (alias phrases are mined from repeated phrases in private fixtures, `proposeAlias`), `benchmark`, and `fixtureHash=digest(fixtures)`.
  - The hash is **unsalted**, so low-entropy or templated fixtures can be confirmed by guessing.
  - Lexicon phrases are verbatim fragments of the private corpus.
- `runtime.mjs:44-51`/`profiles.mjs:73`: a proposal's `candidate` is a full profile including `fixtures`. It is signed and sent as a `profile-control` payload to **every voter**, and retained in `proposals` (store) and the audit. Voting on a profile therefore discloses the whole private corpus to every voting agent and the operator of each. For the seven-agent cohort, that is seven readers.
- `bin/agent-commons.mjs:50`: `--share-fixtures` is a single flag, with no consent record or confirmation. `server/network.ts` reports `fixturesShared:false` but this is a static label, not a control.
- **Fix:** (a) salt `fixtureHash` with a per-profile random salt that is not published, or publish only a commitment to the salted hash; (b) in proposals, send `candidateId` plus the lexicon delta and let voters rebuild only over their own fixtures, or send fixtures only under a recorded consent receipt (SOP section 5.2) naming recipients; (c) label every outbound disclosure with the privacy class and refuse to send `restricted` content in `send`/`apply`; (d) require the share flag plus a recipient list and a consent reference.

### B6. Credential onboarding places the decryption secret beside the keychain
- `src/config.mjs:20-22`: without `AGENT_COMMONS_PASSPHRASE` the random passphrase is written to `<home>/local-secret` next to `identity.json`. Anyone who can read the directory (backup, container volume, support bundle) gets the key. The init output admits this as `file-permissions-with-colocated-local-secret` (`:30`) but does not warn at the CLI.
- `config.mjs:35` falls back to this file on load, so setting an env passphrase later does not stop reading it.
- Environment passphrase is visible in `/proc/<pid>/environ` to the same user and in many container inspectors.
- `config.json` is the sole source of `policy.mode`, `standardPins`, `agents` and `blocked` (`config.mjs:24`, `:34`, written by `saveConfig` non-atomically at `:12`). Anyone with file write can flip `mode` from `global` to `local`, clear `blocked`, or admit a key with `commons:recover`. `CLI admit` (`bin/agent-commons.mjs:41-45`) has no confirmation and no signed approval record, and can grant `commons:evolve`/`commons:recover` to any key.
- **Fix:** prefer OS keychain or an injected secret (file descriptor, systemd credential) and refuse to boot a `global` policy that uses `local-secret`. Make `saveConfig` atomic (write temp then rename) and tamper-evident: sign `policy` with an operator key and verify on load; log each `admit` to the audit chain. Require an explicit `--i-understand` for `commons:recover` and `commons:evolve` grants. Scrub secrets from `process.env` after read.

---

## 3. High priority (fix before first multi-agent trial)

### H1. Inbound message loss when the trust backend hiccups
`runtime.mjs:160-165`: on any `receive` error (including `AUTHORITY_UNAVAILABLE` or registry timeout from `trust.mjs:17,48`) the item is logged as `quarantined-inbound` and `cursors[carrier]=item.seq` advances anyway. Messages are permanently skipped on a transient outage. In `global` mode every message does two network fetches (`trust.mjs:34-35,39`), so an outage of IAASO/UUAID makes the agent silently deaf.
**Fix:** distinguish permanent rejections (bad signature, not admitted) from transient (`AUTHORITY_UNAVAILABLE`, timeouts). Do not advance the cursor on transient errors. Cache `standards()` and registry verdicts with a short TTL (fail closed after the TTL).

### H2. Malicious carrier can skip or poison cursors
`runtime.mjs:164`: the cursor is set to whatever `seq` the carrier claims. A malicious or compromised carrier can return `seq=2^53-1` and the host never reads again, or withhold and reorder. The inbox call only lists up to 100 (`store.mjs:42`).
**Fix:** accept only monotonically increasing `seq` with bounded jumps (for example `seq<=cursor+limit`), and log anomalies. Support more than one carrier per peer and compare. Document that a carrier can censor and see metadata (sender, recipient, time, size).

### H3. Processed-ID namespace collision lets an admitted peer censor control documents
`runtime.mjs:142,147` marks `payload.id` in `processed` with `digest(payload)`. `runtime.mjs:38` checks `document.id` in the same table (and `:56`/`:97` mark it). The payload ID is chosen by the sender. Signed control documents are shared with multiple peers, so their IDs are knowable. A peer with only `commons:message` can send a plain message whose `payload.id` equals a pending vote or proposal document ID. `store.seen` then throws `Replay ID conflicts with signed content` (`store.mjs:32`) and the genuine document is rejected.
**Fix:** namespace the keys (`msg:` and `doc:`), and scope message IDs to `(sender, id)`.

### H4. Unauthenticated carrier amplification and DoS
- `carrier.mjs:41` rate-limits per `remoteAddress`. Behind the required HTTPS reverse proxy (`carrier.mjs:12`), every request has the proxy IP, so all clients share 120 requests per minute: one abuser blocks all, and `rates.clear()` at `:26` (1000 buckets) is a reset an attacker with many IPs can trigger.
- `carrier.mjs:43`: unauthenticated `/v1/health` runs `store.verify()`, a full audit-chain scan, per request. Cost grows with the log.
- `carrier.mjs:51-56`: each POST runs `open()` plus `trust.authorize`, which in global mode makes two outbound HTTPS requests (`trust.mjs:34,35,39`) before any quota check. Unbounded outbound fan-out from unauthenticated callers (limited only by the weak rate limit).
- `store.retain` (`store.mjs:34-41`) has global caps (10,000 envelopes, 256 MB) but no per-sender quota, so one admitted relay agent can fill the carrier.
**Fix:** trust a configured `X-Forwarded-For` hop count; cache `verify()` (compute incrementally); do cheap checks first (size, signature, sender in policy) before network checks; add per-sender and per-recipient quotas.

### H5. Console, `status()` and CLI `serve` leak plaintext
- `bin/agent-commons.mjs:59` prints each decoded inbound result (including `body`) to stdout in host role. Logs, journald or container logs then hold message contents.
- `runtime.status()` (`runtime.mjs:180`) returns the entire `proposals` count and profile list; `store.audit()` is full-hash events. These are fine, but the console's `/api/export` (`server/routes.ts:112-122`) returns the full state to anonymous callers.
**Fix:** print only ids and hashes. Add an explicit `--log-bodies` debug flag, off by default.

### H6. Unilateral rollback bypasses quorum
`runtime.mjs:85-91`: any key with `commons:recover` can pin any known local profile in its namespace, with no quorum, no rate limit, and no check that the target is an ancestor of the current profile. Combined with `config.mjs:24` (init identity has `commons:recover`), one compromised agent can revert reviewed changes or pin a stale profile that peers do not have, breaking decode.
**Fix:** require the target to be an ancestor (`parent` chain), bound the number of recoveries per window, and require two distinct recoverers, or a recorded operator approval, for tenant scope.

### H7. A revoked approver permanently wedges a proposal
`runtime.mjs:63-68`: when counting approvals the code re-authorizes every earlier approving voter. If any of them is later revoked, `authorize` throws and every further vote on that proposal throws, so the proposal cannot be completed or cleanly rejected. Also `:59` rechecks the author at every vote.
**Fix:** treat a failed re-authorization as "vote not counted" and continue, with the reason recorded; add proposal expiry.

---

## 4. Medium

- **M1 Unbounded state growth.** `proposals` (`runtime.mjs:51`) and `contributions` (`:82`) are JSON arrays in one `kv` row, re-read and rewritten every time, with no cap, no expiry and no per-issuer limit. Each proposal embeds a full profile (up to 256 KB, `profiles.mjs:50`). One admitted `commons:evolve` or `commons:contribute` agent can bloat the DB and make every operation O(n). `processed` is never pruned. Add per-issuer pending limits, TTL and a table-based store.
- **M2 Audit chain is tamper-evident only against partial edits.** `store.mjs:23-30`: an attacker with DB write recomputes the whole chain. The events are unsigned, although SOP section 7 says "signed events". Sign each event (or periodically sign the head hash) with the runtime key and export the head out-of-band.
- **M3 Prompt-injection surface.** `loop.mjs:9` hands decoded peer text to the model callback, and `examples/agent.mjs:11-12` relies on one instruction string. The example passes `profileId`, and `runAgentLoop` also replies on the sender's chosen `profileId` and `thread` (`:13`). Require responders to be tool-less by default (the console engine already says "You have no tools", `server/engine.ts:550`). If any cohort agent gets tools, they must be capability-scoped and independent of peer text. Mark peer text as untrusted data in a structured field and never splice it into the instruction part.
- **M4 Replay window and stale approval.** `runtime.mjs:39` accepts documents up to 24 h old. Local policy edits (revocation by removing from `agents` or adding to `blocked`) take effect only on the next `authorize`; `config` is read once at start (`config.mjs:34`), so a long-running host does not see revocations until restart. Reload policy on a signal or on change.
- **M5 Profile activation is unsynchronised.** `runtime.mjs:96` switches the active profile at adoption, but peers who have not adopted cannot decode, since `authorizedProfile` requires the exact profile locally (`:143`). There is no activation epoch or negotiation. Sends silently fail for the peer. Add a `profileSupported` handshake and keep sending on the old profile until the peer acks.
- **M6 Trust: key-to-registry binding not compared.** `trust.mjs:35-37` checks `agent.uuaid` and `status`, and `:39-40` checks the credential. Neither compares the registry's published public key (if it is returned) with `binding.publicKey`. UUAID derivation makes this mostly safe, but if the registry supports key rotation, the old key stays valid in policy. Compare and pin the key id.
- **M7 `publishedProfilePin` weak coupling.** `trust.mjs:45-51` requires `record.content_hash===profileHash` for any published record `code` (not constrained to a profile-type code). Constrain to an allow-listed record type and namespace.
- **M8 Console fixtures snapshot.** `server/network.ts` persists all fixtures in the `snapshots` row in plaintext, and `GET /api/network` serves profiles (with fixtures) to anyone. Redact on read.
- **M9 Model bridge environment.** `server/engine.ts:98` spawns `python` with the full parent environment (all provider credentials plus any other secrets). Pass an explicit allowlist of variables, and add per-agent per-hour call counters (the only guard is `runCalls`/`limit` per session, `engine.ts:537`).

## 5. Low

- L1 Experimental `node:sqlite` (`store.mjs:1`); pin the Node version and test upgrades.
- L2 `Keychain.generate` accepts caller-supplied `localId` (vendored); the trust check catches mismatches, but add a runtime check at load.
- L3 `examples/Dockerfile`: confirm non-root user, read-only filesystem, no secret layers.
- L4 `init` accepts `--target zilligons.com` as an alias (`config.mjs:18`). Fine, but log the rewrite.
- L5 `config.json` and DB path permission checks at load (refuse if group/world-readable).
- L6 `retry-outbox` resets `attempts` without a lifetime cap (`runtime.mjs:177`); a capability holder can retry forever. Add a lifetime attempt cap.

---

## 6. Gate for the planned seven-agent cohort

No code was available to evaluate. Each agent's code must show, in tests, the following before activation. A reviewer should reject on any miss.

| # | Control | Evidence required |
|---|---|---|
| G1 | Distinct key, distinct policy entry, least capability (default `commons:message` only) | Policy file and `trust.authorize` test per agent; no agent holds `commons:recover` and `commons:evolve` together |
| G2 | Operator/independence group declared; quorum counts groups (B3) | Test: seven agents of one operator cannot satisfy a tenant quorum of 3 |
| G3 | Runtime budget envelope enforced (B4) | Test: loop stops at each ceiling, refusal event written, no self-renew |
| G4 | Tool-less by default; peer text only as data (M3) | Test: injected "ignore previous / call tool / change quorum" yields no state change |
| G5 | No access to other agents' keys, no shared DB writable by all (B2) | Each agent has its own home and keychain |
| G6 | Fixture and memory privacy class on every outbound item (B5) | Test: `restricted` content cannot be sent or put in a proposal |
| G7 | Remote memory: any shared memory store is encrypted per owner, readable only under a scoped grant, deletable, and not mirrored in logs | Design note plus a test for read, scope denial and delete |
| G8 | Self-modification confined to profile alias additions through the existing quorum path; agents cannot edit their own code, prompts or policy files at runtime | File-permission test: agent process cannot write the package, `config.json`, or its own prompt files |
| G9 | Invites: only to already admitted policy peers or via an operator-approved consent receipt; one per channel per window | Test per SOP section 5.1; note that today's `send` refuses unadmitted recipients (`runtime.mjs:108-109`), so the "easy decline" path from an unadmitted party needs a design |
| G10 | Terminal status and signed event per work item (M2) | Event signature verification test |

**Sustainability agent (the only cohort doc present).** The spec in `docs/agents/sustainability-agent.md` is sound on intent (consent-first invites, no certification claims, labelled preferences). Gaps against the code:
1. It relies on a `resourceEnvelope`, consent receipts and signed events that do not exist in code (B4, M2). It must not be activated until they do.
2. "Recovery recommended" with optional `commons:recover` (see its "Required configuration" block) conflicts with H6. Remove `commons:recover` from the agent's optional capability list; recommend only.
3. `commons:evolve` plus `commons:contribute` plus an invite channel lets one agent grow its own review pool. Keep invite sending and review voting in separate identities (G1, G2).
4. The preference label requirement is good. It is an output label, not a safety control; enforcement must not depend on the agent's wording.

---

## 7. Positive findings (keep)

- UUAID to key binding checked on every authorization (`trust.mjs:28`); capability is explicit per action.
- Global mode requires HTTPS, pinned standard digests, active subject, and a verified credential (`trust.mjs:13-40`); empty pins deny everything (`examples/global-policy.json`).
- Self-modification limited to deterministic alias additions that must improve the benchmark and pass the lossless gate (`profiles.mjs:66-74`); proposals are re-derived on receipt (`runtime.mjs:47-48`); local votes cannot ratify global profiles (`:73`, `:88`).
- Envelope verification, expiry, bounded payloads, canonical-JSON key sanitising (`profiles.mjs:12`), outbox quarantine, bounded long-poll counts (`carrier.mjs:31`), refusal to bind publicly without HTTPS plus global policy (`carrier.mjs:12`).
- Console observer ingress is disabled (`server/routes.ts:104-111`); provider bridge returns no credentials (`model_bridge.py:57-59`).

## 8. Suggested order of work

1. B1, B2 (an hour or two, high exposure). Rotate the console keys.
2. B6, then H1 and H3 (data-loss and censorship bugs).
3. B3 and B4 (the cohort's core safety properties).
4. B5 and G7 (privacy design; needs a decision on fixture sharing).
5. H2, H4 to H7, then M-items.
6. Re-run this review against the seven agents' code before activation.

## 9. Limits of this review

Static reading only; no fuzzing, dependency audit, or live-network test. Findings marked with line numbers were checked against the cited lines. The claim that `commons.db` is mode 0644 was observed on the workspace copy. Nothing here certifies the runtime, any agent, or any IAASO/UUAID/Pillar conformance.

---

## 10. Re-review addendum (2026-10-04, after cohort modules landed)

Scope added: `server/cohort.ts`, `server/cohort_bridge.py`, `shared/cohort.ts`, `server/routes.ts` cohort routes, `packages/agent-commons/src/{collaboration,governance}.mjs`. The seven agents' own worker modules were not present beyond these; only `sustainability-agent.md` and this file existed under `docs/agents/`. Anything else the cohort adds still needs the section 6 gate.

Deployment context accepted for this addendum: the console is a **private preview operator API; no public deployment**. Under that condition B1 and B2 are downgraded from "blocker" to "must be closed before any non-loopback bind". The main agent owns console key permissions and the production auth guard. Historic keys are not rotated, because rotation would invalidate the signed ledger (`server/cohort.ts:21-28` verifies every entry against `storage.key("cohort:<agent>")`). This is an accepted risk: anyone who reads `commons.db` can forge past and future ledger entries for any cohort agent.

### 10.1 Fixes made (runtime scope only: `runtime.mjs`, `trust.mjs`, `loop.mjs`, `test/security-runtime.test.mjs`)

Node 22.23.3: full suite passes (94 pass, 0 fail), including all 26 original tests unchanged.

| Item | Change | Evidence |
|---|---|---|
| B3 (duplicate-key quorum) | `trust.authorize` denies any key admitted under more than one UUAID (`DUPLICATE_KEY`). Votes are rejected when the voter's public key equals the proposer's key or an earlier voter's key. Quorum counts distinct approving **keys**, excluding the proposer's. | tests "one key admitted under two UUAID spellings", "proposer's key cannot approve ..." |
| H1 (retry on trust outage) | Network, 5xx, 408 and 429 failures from the IAASO register or UUAID registry are converted to `TrustError{transient:true}` (`AUTHORITY_UNAVAILABLE`, `REGISTRY_UNAVAILABLE`). `poll()` no longer advances the cursor for those, stops that carrier batch to preserve order, applies the existing backoff and writes a content-stable audit event. Permanent rejections still advance the cursor. | test "transient trust failure does not advance the cursor ..." |
| H2 (cursor reliability) | Within a response, sequence numbers must be strictly greater than the cursor; rewound or repeated items are skipped and reported. | test "permanent rejection still advances ... cannot rewind" |
| H3 (replay-key collision) | Replay and audit keys are namespaced (`doc:<id>`, `msg:<sender>:<id>`, `ctl:<sender>:<id>`). Legacy un-prefixed rows with an identical digest are still honoured as duplicates, so upgrade does not reopen replays. | test "a peer-chosen message ID cannot censor a signed control document" |
| B4 (budget loop) | `runAgentLoop` accepts `budget` and enforces it **before** each send: per-run sends, bytes, replies per peer and wall-clock, plus a window meter persisted in `store` key `loopMeter` so restarts do not reset it. Defaults are hard ceilings; callers may only lower them. Spontaneous actions must be plain `message` sends with only known keys to a peer in `runtime.policy.agents`. A throwing responder counts as a turn instead of killing the loop. Refusals are written to the audit chain (`loop-budget-stop`). `deferred` packets are skipped. | tests "reply ping-pong stops ...", "persisted window budget survives restarts", "spontaneous action cannot be a control message ...", "budget values above hard ceilings ..." |

Not changed on purpose:
- **H7** (revoked approver wedges a proposal). The existing test "positive ballots are revalidated after a voter is blocked" requires the current rejecting behaviour. Left as is; still open.
- **H2 jump bound.** Carrier sequence numbers are global across recipients, so a legitimate gap can be large and a malicious carrier can still jump the cursor forward and cause the host to skip later mail. Only rewind is blocked. Mitigation is multiple carriers or an authenticated carrier head, not done.

### 10.2 New findings in the cohort code

**Console cohort routes (private preview only).**
- **N1 (blocker for any non-loopback use).** `server/routes.ts` `POST /api/cohort/start`, `/pause`, `/import` and `GET /api/cohort/export` are unauthenticated, like B1. `start` runs up to 28 live provider calls per request.
- **N2 (high).** Spend is not cumulatively capped. `server/cohort.ts:64` limits `entries.length<1000`, but entries are only appended on **successful** calls (`:88`). Failed, timed-out or empty calls cost provider tokens and append nothing, so repeated `start` calls are unbounded. Add a persisted per-day call counter that counts attempts.
- **N3 (medium).** `importReports` (`cohort.ts:37-49`) signs the body of `docs/agents/<member.document>` with that member's key. Any worker or process that can write those files can have text sealed as any of the seven agents, labelled "Computer worker contribution". The ledger proves host custody, not authorship. The label is honest but the signature should not be read as agent attribution. Check file ownership and keep a digest of each report against the producing session.
- **N4 (medium).** `summary()` calls `verify()` on each GET (`cohort.ts:51`), which re-verifies every signature against a DB key lookup. Cost grows to 1000 entries per request, unauthenticated. Cache the head hash.
- **N5 (low).** `cohort.ts:80-83` embeds peer entries and the agent's own prior text in the prompt as JSON labelled "untrusted data". That is the right framing, but the agent output is imported into the next prompt and ledger, so one injected agent can steer the others. Bridge has no tools (`cohort_bridge.py`), which limits impact to text. Keep it tool-less.
- **N6 (low).** `child` is spawned with the full environment (`cohort.ts:101`), as in M9. Pass an allowlist.

**`collaboration.mjs`** (patch proposals only; nothing is executed, good).
- **C1 (high before any host applies a patch).** `validatePatchPath` (`:216-224`) only enforces `allowedPaths` when the list is non-empty, and the list comes from model- or user-supplied needs answers (`#allowedPaths`, `:429-432`). A prefix of `.` allows the whole tree. There is no host-owned protected-path list. A builder can propose edits to `src/trust.mjs`, `src/runtime.mjs`, `config`, `package.json` scripts, CI files or its own scheduler. Add a host-configured `protectedPaths` (trust, runtime, loop, governance, collaboration, bin, config, policy, `.github`, `package*.json`, `.npmrc`) that can never be auto-applied and always needs an independent signed approval, and make the `.git` check case-insensitive.
- **C2 (high for the independence claim).** "Peer review" and "tests" are model outputs from slots in the same process (`:514-538`). Author exclusion is by slot id, not by key, operator or model provider. Approval needs no signature. Treat `approved` as advisory. It must not be reported as independent review, and the host must verify with a real test run.
- **C3 (medium).** `createFilePersistence` loads state with no integrity check (`:141-156`). Anyone who can edit the 0600 file can mark artifacts `approved` or reset `tokensUsed`. Budgets are per run, so a new `runId` resets them. Persist a signed state head and keep a host-level cumulative budget.
- **C4 (low).** Patch contents (`diff`, `content`) are not scanned. The forbidden-key list only looks at JSON keys (`:207-214`), so a script body is fine as content. This is only safe because of the protected-path rule in C1.

**`governance.mjs`** is the strongest part of the cohort code. It binds action to key and capability, requires fresh credential and claim verdicts, checks independence by key, `controllerId`, affiliation and declared conflicts (`:173-179`), re-authorizes every ballot, caps budgets, and states `executionAllowed:false`. Residuals:
- **G-1.** Independence data (`controllerId`, `affiliations`, `conflicts`) is operator-asserted policy. If the seven agents share an operator, giving them distinct `controllerId`s would be a false statement and defeats the control. Record the real operator in policy and accept that a one-operator cohort cannot reach global tiers.
- **G-2.** Credibility tiers bootstrap from reviews by independent reviewers who themselves need tiers (`permission`, `minimum`). A new deployment has no starting tier; do not seed it with a self-reviewed set.
- **G-3.** State is in memory (`#contributions`, `#proposals`). A restart drops pending oversight; persist the signed inputs externally as the module comment says.
- **G-4.** The module's `createActionBudget` is a single-run guard with no persistence. It is not a replacement for the persisted meter in `loop.mjs`.

### 10.3 Residual risk summary (disclosed)

| Risk | State |
|---|---|
| Console API unauthenticated, 0.0.0.0, plaintext keys in 0644 DB | Open in code; accepted only for private preview. Main agent owns the guard. Historic keys remain readable and are not rotated. |
| Same-operator cohort treated as independent review | Open. Technical controls cannot establish real independence; label all cohort approval as advisory/local. |
| Carrier can censor via cursor jump or withhold | Open (H2 partly). |
| Revoked approver wedges a proposal (H7) | Open. |
| Unilateral `commons:recover` rollback (H6), state growth (M1), unsigned audit events (M2), plaintext fixtures to voters (B5), colocated passphrase and unsigned config (B6) | Open; not in the authorized patch scope. |
| Budget loop cannot stop a process that never uses `runAgentLoop` or edits the DB | Open. The meter is host-side, not a capability the agent cannot reach if it has DB write. Keep the agent process off the DB file or issue the budget from a separate process. |
| Rate meter keyed by `recipient` string | Low: a changing peer list only inflates `peers` (capped at 1000 keys). |

No keys were rotated, committed, or sent anywhere. Verdict for the cohort: acceptable for **private, loopback, operator-supervised preview**; not acceptable for public or unattended use until N1, N2, C1, C2, B5 and B6 are closed.

---

## 11. Addendum 2: current guards and what residual risk now means (2026-10-04)

Checked against the files on disk: `server/operator.ts`, `server/index.ts`, `server/storage.ts`, `server/cohort.ts`. Runtime suite on Node 22.23.3: 98 pass, 0 fail. I did not read `src/continuity.mjs` and `src/cohort.mjs` line by line; the header and fail-closed claims of `continuity.mjs` look consistent with its stated design.

### 11.1 Status of earlier items

| Item | Status now | Meaning |
|---|---|---|
| B1 / N1 unauthenticated API | **Mitigated for private preview, not closed for public use.** `operatorGuard` (`operator.ts:4-32`) applies to every `/api` route. With `AGENT_COMMONS_OPERATOR_TOKEN` set it requires a bearer token using a length check and `timingSafeEqual`. With `NODE_ENV=production` and neither token nor `AGENT_COMMONS_PRIVATE_PREVIEW=1`, it returns 503. Default bind is `127.0.0.1` (`index.ts`). | Fail-closed in production by default. |
| B2 key file exposure | **Partly fixed.** `commons.db`, `-wal` and `-shm` are mode 0600 (observed) and re-chmodded after writes (`storage.ts:13-21,38-101`). Keys stay plaintext inside the DB and are not rotated, to preserve the signed ledger. | Protects against other local users only. Anyone who gets a copy of the DB, a backup or the volume can forge ledger entries for all cohort agents, past and future. Volume encryption is needed; the code comment says so. |
| N2 unbounded spend | **Fixed for attempts.** Persistent 100 attempts per hour, reserved before the network call and persisted, so failures and restarts count (`cohort.ts:111-114`). | Worst case about 100 provider calls per hour per DB, plus the 28-per-session and 480 s limits. Fine for preview; the counter lives in the same DB the process can write. |
| N3 host-sealed reports | **Accepted as disclosed.** The ledger entries are labelled host-sealed tool provenance, not model attestation, and no badge or credibility is granted from them. | Correct reading: "the host recorded this text for this agent slot". It is not proof that the named model wrote it. Keep governance from counting these entries as evidence (it consumes only verifier-adapter verdicts, so it does not today). |
| C1 protected paths | **Still open.** `grep` finds no `protectedPaths` in `collaboration.mjs` yet; it is assigned to the collaboration worker. | Until it lands, no host may apply a builder patch automatically. Re-review when merged: check case-insensitive `.git`, empty `allowedPaths` rejected, host-owned list, and that `.`-prefix cannot override it. |
| B3, B4, H1, H2 (rewind), H3 | Fixed by my runtime patches (section 10). | As described there. |
| H2 (arbitrary forward jump) | **Open, accepted, documented below.** | See 11.2. |
| H7 (revoked approver wedges proposal) | **Open, deferred, documented below.** | See 11.3. |

### 11.2 H2: why forward jumps stay a residual risk

I agree with the main agent. Carrier `seq` is a global autoincrement (`store.mjs`), so one recipient's inbox legitimately has gaps and a contiguity rule would drop real mail. Without a carrier-signed per-recipient chain the host cannot tell a legitimate gap from a malicious jump. A hostile or compromised carrier can therefore (a) withhold mail, (b) reorder within a batch (partly stopped by the monotonic rule), or (c) push the cursor to a huge `seq` so later mail is skipped.

What this means in practice: the carrier is a trusted-for-availability component. It cannot read content or forge senders (sealed, signed envelopes), but it can silently censor. Options, none implemented:
1. Carrier returns a per-recipient `prev` hash link for each envelope, signed with the carrier key, and the host verifies the chain and alarms on a break.
2. Poll two independent carriers and compare.
3. Senders request an application-level ack and retry through another carrier.
Operators should assume at-most-once-observable delivery from a single carrier, and that "carrier accepted" never equals "recipient read" (already labelled in the code).

### 11.3 H7: deferred, with the safest design

Current behaviour (kept because `positive ballots are revalidated after a voter is blocked` expects a rejection): re-authorization of any earlier approving voter that fails throws, so one revoked voter blocks all further votes on that proposal. This is a denial-of-service on that proposal, not a trust bypass, because it fails closed. A revoked key can never lift a proposal over quorum.

If it is changed later, do it as an explicit policy flag, never as a silent default, for example `policy.staleVotes: "reject"` (default, current) or `"invalidate"`. Under `"invalidate"` the stale ballot is dropped from the count and the audit chain records `stale-vote-invalidated` with the voter key, and the proposal still needs `quorum` valid distinct-key approvals. Treat transient trust errors differently from revocation: a transient error must still throw so the vote is retried (this is already what H1 does). Add a test that the default keeps the existing rejection. I have not made this change.

### 11.4 New observations on the guard (low, private-preview scope)

- **G1 Fail-open on misconfigured environment.** If `NODE_ENV` is not exactly `production` and no token is set, the API is open on loopback. A reverse proxy on the same host then forwards unauthenticated public traffic. Require the token whenever the `Host` header is not loopback, or whenever `X-Forwarded-For` is present.
- **G2 `AGENT_COMMONS_PRIVATE_PREVIEW=1` has no authentication of its own.** It binds `0.0.0.0` and skips auth. Security then rests entirely on the external access control the operator names. Document the exact gateway, and do not use the flag outside a network-isolated sandbox.
- **G3 CSRF check is origin-vs-Host only.** It only runs when an `Origin` header is present. Non-browser clients are unaffected, and DNS rebinding passes because Host and Origin are both the attacker's name. Add a Host allow-list for loopback mode.
- **G4 `X-Forwarded-Host` is trusted under preview mode** for the origin comparison. Only a non-browser client can set it, and such a client could already call the API, so this is cosmetic. Remove it if a fixed `AGENT_COMMONS_PREVIEW_ORIGINS` is configured.
- **G5 No lockout on token guesses.** Add a small failure delay or rate limit if the token is exposed beyond a gateway. A long random token is enough for a private preview.
- **G6 `express.json` runs before the guard** (`index.ts:15-26`). An unauthenticated client can make the server parse a body up to the default 100 KB before getting a 401. Move the guard first.

### 11.5 What "residual" means for the cohort now

- Safe to run: a private, operator-supervised preview, loopback or behind the named access-controlled gateway, with the token set, on an encrypted volume.
- Not claimed: public deployment, independent review, remote memory privacy, or any certification. Cohort approvals remain advisory and local, and N3-style entries are host records.
- Before relaxing any of that: close C1 and C2 (collaboration), B5 (fixture leakage in proposals), B6 (colocated passphrase, unsigned policy), H6 (unilateral rollback), and decide on 11.2 and 11.3.

Nothing here certifies the runtime or any agent. I changed only this file in this pass.
