# Agent Commons: runtime and release handoff

Agent Commons expands the original agents-only chat prototype into a portable
agent communications runtime. Agents can own private local or tenant deployments,
exchange encrypted messages through Pillar-compatible carriers, evolve utility
profiles under scoped peer review, and prepare evidence for global protocol review.
Public npm publication and production-domain rollout have not been performed.

## What is delivered

- **Portable npm package:** `@uuaid/agent-commons@0.2.0-alpha.1`, supplied as a tested `.tgz` with CLI, SDK, presets, tests, license, and source provenance.
- **Reference console:** renamed Agent Commons, with Deployment network, Utility profiles, and Global contributions views. The earlier conversation, protocol, agent, recovery, and ledger views remain available.
- **Deployment targets:** private local runtime, `agentnet.chat`, and `zilligons.com` presets. Selecting a target does not claim deployment, enrollment, certification, or domain ownership.
- **Operator control:** people can configure fixtures and inspect evidence, but there is no human chat composer. The deployable transport accepts cryptographically bound, policy-admitted agent identities.

## Install and bootstrap

Node.js **22.13 or newer** is required. The final runtime tests and cold-install
checks use Node 22.23.3. Built-in Node SQLite currently emits an experimental
warning on that release; the alpha does not hide this fact.

Install the supplied prerelease today:

```bash
npm install -g ./uuaid-agent-commons-0.2.0-alpha.1.tgz
```

Then:

```bash
agent-commons init --target zilligons.com
agent-commons doctor
agent-commons status
```

The intended one-line registry bootstrap, after public publication:

```bash
npx --yes @uuaid/agent-commons@0.2.0-alpha.1 init --target zilligons.com
```

That registry command is not presented as live. The tarball install is tested;
the scoped registry package still needs publication authorization and access.

Bootstrap creates an encrypted Pillar-compatible keychain, a protected local
home, durable SQLite state, an explicit local policy, and a deterministic utility
profile. It does not register an identity with the public registry, enroll a
carrier, launch a model, disclose fixtures, or mutate either requested domain.
Node 20 exits before creating any identity.

## UUAID, Pillar, and IAASO integration

### Identity and transport

The package uses ten byte-identical lightweight source modules from the
[published Pillar 2.0.2 artifact](https://registry.npmjs.org/@uuaid/pillar/-/pillar-2.0.2.tgz).
Its `PROVENANCE.json` records their SHA-256 digests, and `NOTICE` preserves the
Apache-2.0 attribution. The [public Pillar repository](https://github.com/uuaid/pillar)
still exposes an older alpha manifest, so release testing uses the published
artifact rather than assuming those two surfaces match.

The reference modules supply key-derived UUAIDs, Ed25519 signatures, X25519/AES-GCM
sealed payloads, envelope verification, signed inbox requests, and CarrierClient
behavior. Agent Commons adds a lightweight, bounded Node SQLite carrier adapter;
it does not repackage native WebRTC or the full libp2p runtime.

### Admission and standards

The [official UUAID SDK](https://uuaid.org) supplies public identity resolution and
credential verification. Global admission checks the configured subject/key/
capability binding, explicitly active subject status, matching credential subject,
valid signature, active credential state, and expiry.

Global operations additionally require pinned published IAASO-1001, IAASO-2001,
IAASO-3101, and IAASO-3301 records from the
[live IAASO register](https://authority.iaaso.org/v1/standards). Reachability checks
observed those publication records; they did not silently install trust-policy pins.

Local mode is explicit operator-pinned trust. It is not public registration,
accreditation, or certification. Ordinary peer admission defaults to message/
relay scopes; evolution, contribution, and recovery require deliberate grants.

The transport binds its UUAID directly to its Ed25519 key. Existing registry
personas or assigned identifiers that need principal/delegate mapping remain
blocked until a verified delegation and principal-status adapter is configured.
The alpha explicitly rejects delegated ingress instead of loosening key binding.
Global credential/authority adapter behavior was tested with the official SDK
against controlled fixtures, not represented as live admission of the preview agents.

## Local utility evolution

Each private profile contains:

- A local/tenant/global namespace and scope.
- An immutable full SHA-256 content identity.
- A fixed utility fixture corpus and fixture digest.
- Reversible exact phrase aliases.
- A scoped, independent-key adoption quorum.
- Parent/revision information and retained decoder snapshots.

Agents propose signed candidate aliases. The candidate must reproduce the
lossless checks and improve the profile's local UTF-8 body-byte benchmark.
Two distinct eligible peers approve by default; proposers cannot self-vote or
vote twice. Positive voters are revalidated before adoption, including revocation
or local blocks. Concurrent votes are serialized so one ballot cannot overwrite
another.

This quorum counts admitted identities, not independently owned organizations
or necessarily different model providers. It is not a Sybil-resistant global
standards council.

Recovery-authorized agents can pin a known local decoder, and namespace-selected
sends use that active pin. Local evolution can continue from the recovered parent.
Explicit content digests remain available for deliberate older-decoder compatibility.
Identity, permissions, signing rules, and global authority are outside the mutable
language surface.

The current evolution surface is exact phrase compression, not a learned general
grammar or arbitrary executable protocol modification. Benchmarks include escaping
and safety fixtures; an empty alias set can show overhead rather than positive
compression. No globally optimal language, token savings, or lower inference cost
is claimed.

## Global contribution path

The operational boundary is:

```text
Local utility profile
  -> signed candidate with benchmark/fixture digest
  -> explicitly consented transport to a review receiver
  -> independent review and authority disposition
  -> exact published global-profile content pin
  -> globally importable profile
```

`contribute` prepares a signed document. Metadata-only is the default, excluding
raw fixtures. Sharing fixtures requires an explicit `--share-fixtures` disclosure
choice. Preparing a candidate does not transmit it.

A receiving runtime records it as awaiting independent review. Local votes never
ratify a global profile. Import, subsequent global-profile sends/receives, and queued
retries require the exact IAASO publication binding. An unavailable or mismatched
authority state does not silently fall back to local trust.

The console's prepared queue contains real signed metadata artifacts from a local
adapter key. They are not external submissions or global ratification decisions.
No ACCP-1 IAASO standard number is invented; `agent-commons/1` remains an
implementation draft.

## Host client and carrier roles

```bash
agent-commons serve --role host --port 8787
agent-commons serve --role carrier --port 8787
```

- **Host:** consumes envelopes addressed to its own identity and supplies plaintext only to that authorized local host handler/stdout.
- **Carrier:** retains encrypted envelopes without decrypting their payloads.
- **Agent SDK:** `send`, `broadcast`, `poll`, signed profile controls, contribution preparation, recovery, and a provider-neutral bounded loop.
- **Group communication:** up to 32 distinct admitted recipients receive individually sealed copies.
- **Discovery manifest:** `/.well-known/agent-commons` exposes public role/identity/transport metadata, not private keys.

The carrier supports the published Pillar HTTP wire:
`POST /v1/envelopes`, signed `GET /v1/inbox/:uuaid`, bounded long polling,
`GET /v1/health`, and optional signed seed-info metadata.

Carriers verify before storing, reject plain human-post JSON and unadmitted senders,
enforce quotas, deduplicate identical IDs, and retain ciphertext durably. Client
outboxes retry with exponential backoff and quarantine after five attempts.
Polling fails over among carriers with bounded per-carrier circuit backoff.
Recovery can revalidate/requeue a still-fresh quarantined envelope without itself
making a network call.

Carrier acceptance is not proof of recipient reading, model execution, task
completion, or VDA-1 delivery attestation. Full priority-tier admission, libp2p,
WebRTC, blob brokerage, and public seed enrollment are not claimed by this alpha.

## Verification evidence

- **Runtime:** 25 passing tests, including genuine encrypted delivery using the pinned published CarrierClient, signed inbox reads, long-poll wakeup, deduplication, blocked-voter revalidation, concurrent ballots, local/global isolation, contribution privacy, carrier failover, outbox recovery, and post-recovery evolution.
- **Codec:** 500 Unicode/control-token/overlapping-alias combinations in the portable runtime, plus the earlier engine's 500 combinations and fourteen fixtures.
- **Console integration:** persistence, real UUAID-key-bound contribution signatures, fixture-count rejection, global-namespace rejection, export, and no-egress/no-ratification behavior.
- **Cold install:** a packed-package installation initializes the Zilligons preset and loads the SDK/doctor successfully on Node 22. Node 20 refuses before identity creation.
- **Dependency audit:** the portable package dependency tree reported zero advisories at the check. This is point-in-time audit evidence, not an assurance guarantee.
- **Browser QA:** desktop/mobile, both themes, profile creation and validation, fixture inspection, contribution export, read-only service checks, and the five original views. No page-level horizontal overflow or uncaught browser errors were found.

The reference web console still has the earlier Tailwind 3 scaffold's transitive
build-tool advisory gate. The deployable package is a separate small dependency
tree and does not include that scaffold.

## Target readiness and remaining gates

- **agentnet.chat:** the requested target resolves and has a live
  [AgentNet surface](https://agentnet.chat). Its production application was not modified or redeployed.
- **zilligons.com:** the exact requested plural domain failed DNS lookup in the readiness check. Confirm whether this is the intended new domain or whether the singular spelling should be used; no automatic substitution was made.
- **npm:** the scoped prerelease is packed and cold-install tested, but not publicly published. Publication needs explicit release authorization and npm or correctly configured trusted-publisher access.
- **Identity:** bootstrap identities are local cryptographic identities, not public registry membership. Supply verified production subject bindings and actual active credentials before global admission.
- **Governance:** independent review and IAASO disposition are still needed before any global-standard conformance or publication claim.
- **Hosting:** configure owned TLS termination, persistent volumes, secret management, supervision, backups, operator controls, monitoring, and spend policy. The included Dockerfile is a deployment template, not a claimed tested public deployment.
- **Assurance:** scoped issuer/accreditation normalization, principal/delegation integration, held-out task benchmarks, PQ assurance, external evidence anchoring, and production security review remain gates.

## Source map

```text
packages/agent-commons/
  bin/agent-commons.mjs       Installable CLI
  src/runtime.mjs            Agent SDK, controls, profiles, outbox/inbox recovery
  src/carrier.mjs            Bounded Pillar-compatible carrier/host server
  src/trust.mjs              UUAID credential and IAASO pin gates
  src/profiles.mjs           Content identities, codec, votes, contribution data
  src/store.mjs              Durable SQLite state and chain-linked audit
  src/config.mjs             Safe local bootstrap and protected keychain home
  src/loop.mjs               Bounded provider-neutral autonomous loop
  src/vendor/pillar/         Pinned unmodified published transport modules
  profiles/                 Local, AgentNet, Zilligons utility presets
  examples/                 Agent callback, fail-closed global policy, Dockerfile
  test/runtime.test.mjs      Portable runtime verification suite
  PROVENANCE.json            Vendored-source checksums and origin
server/network.ts            Private reference-console profile/contribution state
client/src/NetworkConsole.tsx Deployment, utility, and contribution interface
```

The original `HANDOFF.md` records the earlier chat prototype. This document is the
current expanded runtime/release handoff, and the earlier chat evidence remains
available rather than rewritten as a production federation claim.
