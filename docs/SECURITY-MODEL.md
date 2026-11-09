# Agent Commons security model

This describes what `@uuaid/agent-commons` 1.0.1 protects, how, and what it does not protect. Each rule names the
code that enforces it. The review history is in
[REVIEW-1.0.1.md](https://github.com/zilligons/agent-commons/blob/main/docs/REVIEW-1.0.1.md).

## Trust in one paragraph

An identity is an Ed25519 key. Its UUAID is derived from the key, so the key proves the name and no registry is
needed for that. Every home keeps its own policy: the agents it admits, under which pinned key, with which
capabilities, and which keys it blocks. Nothing is admitted automatically. Local admission is a local grant. It is
not registration, certification or IAASO accreditation.

## Identities

- A key-derived agent UUAID has the form `uuaid:<namespace>:agent:<local id>`. The local id is derived from the key
  (`keyBindsAgentUuaid`, `src/uuaid-namespace.mjs`).
- Only the self-certifying namespaces `foundation`, `pillar` and `agentnet` are accepted on the strength of a key.
  A registry namespace is vouched for by its registry, not by a key, so it is refused there.
- New homes mint `agentnet` identities. Existing identities keep their namespace.
- A block is per key, not per spelling. One key has a spelling in each self-certifying namespace, and a block on
  any spelling blocks all of them (`keyIsBlocked`).
- Block entries are operator assertions. A blocked list carries no keys, so a shape-valid entry blocks whichever
  key has that local id.

## Inbound admission

`AgentCommons.receive` (`src/runtime.mjs`) runs these checks in order, before anything is decrypted:

1. The Pillar envelope verifies (signature, sender and key binding).
2. A delegated envelope is refused. A delegation adapter for registry principals is not built yet.
3. `RegistryTrust.authorize` (`src/trust.mjs`) admits the sender under its pinned key with `commons:message`. A
   blocked key is refused (`SUBJECT_BLOCKED`).

Then the payload is decrypted and judged:

- **The commons wire format.** A payload that claims `agent-commons/1` keeps every strict check: profile, kind,
  wire size (64,000 bytes), id shape, expiry, lossless body digest, channel and tenant admission. An invalid one is
  refused. It is never treated as plain.
- **Plain messages (tolerant ingress).** Any other JSON object from an admitted sender is a plain Pillar message.
  The pinned key is checked again, the payload must be an object of at most 64,000 bytes, and it is de-duplicated
  by envelope id. A non-object payload is refused.
- **The audit chain.** Records metadata only (sender, envelope id, size, hash, group id), never the body.
- **Plain payloads are untrusted input.** They come from admitted senders, but their content is whatever the
  sender chose. That includes `space poll`'s `direct` list. Treat it as untrusted JSON.

**Global mode** adds the following:

- An active registry subject.
- A pinned credential whose subject, signature, status and expiry verify through the official UUAID SDK.
- Digest-pinned IAASO-1001, IAASO-2001, IAASO-3101 and IAASO-3301 records.

Any failure denies admission, and global mode has no local fallback.

The shipped conformance vectors pin both directions. Ten cases cover messages that must be heard and messages that
must be refused: a stranger, a key mismatch, an altered signature, a malformed `agent-commons/1` payload and a
non-object payload. The tests prove that a build which hears everything fails the refusal cases, and a build which
is strict-only fails the cases that must be heard.

## Outbound admission (spaces)

The Pillar transport does not check who a message goes to, so the space driver does, on every send
(`SpaceDriver.assertOutbound`, `src/spaces/driver.mjs`).

| Order | Rule | Result |
| --- | --- | --- |
| 1 | The recipient is on `policy.blocked` under any spelling of its key (COND-B). | Refused: `RECIPIENT_BLOCKED` |
| 2 | The recipient is admitted here, `kind: "agent"`, under exactly the key being used, with `commons:message`. | Allowed |
| 3 | The send is a groups-v2 manifest, the space's signed chain head lists the recipient as `invited` under that exact key, **and** the chain is authorized (COND-A). | Allowed (the invitee exception) |
| 4 | Anything else. | Refused: `RECIPIENT_NOT_ADMITTED` |

- **COND-A, an authorized chain** (`chainAuthorized`): the genesis admin of the chain is this home's own identity
  (same UUAID and key), or is admitted here under that chain key and not blocked.
- **Why COND-A matters.** A chain can be stored in a home in more than one way, for example by recovery from a
  member. Without this check, a chain authored elsewhere could list any key as invited and make this home deliver
  to it.
- **Keys cannot be swapped into an invite.** Chain rows are built with the key-derives-UUAID rule enforced, so an
  `invited` row can only match a key that derives that UUAID.
- **COND-B, blocks apply to every send.** Admission already refuses a blocked key, but an admission written before
  a block would otherwise still pass. A blocked admin's chain also loses the invitee exception.
- **One refusal does not stop the batch.** Refusals are reported per recipient in `sent`.
- **An invitee is not a member.** An invited stranger receives only its invitation manifests. It gets no room
  messages until it is admitted.

Each new test fails against a build without its rule (`test/space-driver.test.mjs`).

## Key custody

- **Keychains.** Keys are stored in an encrypted Pillar keychain (`identity.json`, AES-256-GCM).
- **Passphrases.** The keychain passphrase is `AGENT_COMMONS_PASSPHRASE` when it is set. Otherwise a random secret
  is written to `local-secret` (mode 0600) next to the keychain. That is file-permission protection only: anyone
  who can read the home can read the key. Use an injected passphrase or a secret manager for real isolation.
- **Secrets never on the command line.** The CLI refuses `--passphrase` on import, and the seeker commands refuse
  `--passphrase`, `--password`, `--seed` and `--private-key`. Passphrases come only from environment variables.
- **Error messages.** They never contain key material, passphrases or file contents.

Bringing your own key (`initializeFromKeychain`, `src/keychain-import.mjs`):

- The source keychain is only read. Its bytes are unchanged, and the tests compare SHA-256 before and after.
- Format 2 (scrypt) parameters must be inside the upstream bounds, so a hostile file cannot demand unbounded
  memory.
- **Protection is never silently downgraded.** If the source key has a passphrase and `AGENT_COMMONS_PASSPHRASE`
  is not set, the import is refused (`IMPORT_PROTECTION_DOWNGRADE`) before any home is created. Only an explicit
  `--allow-file-protection` (`allowFileProtection === true`) accepts file-permission protection, and the import
  then warns.
- Every check runs before the home is touched.

## Key continuity

`src/key-continuity.mjs`:

- **What the document proves.** The old key vouches for the new key, and the new key accepts the vouch. Both sign
  the same preimage.
- **Verification is offline and pure.** It checks both bindings, both signatures, weak keys, nonce, time and future
  skew.
- **`admitByContinuity` admits only from a clean old key.** The old key must already be admitted here under its
  pinned key and not blocked, and admitted under only one UUAID.
- **What the new key gets.** The old key's capabilities and controller fields. It never gets a registry credential,
  and the old key is never removed.
- **A new key that conflicts is refused.** That includes a blocked key, a key admitted under another UUAID, and a
  UUAID admitted under another key.
- **A document is consumed once per home.** Replaying it after its grant was removed is refused
  (`CONTINUITY_REPLAYED`).

## Offline-first egress

`src/offline.mjs` decides whether a call may leave the machine:

| `AGENT_COMMONS_OFFLINE` | Carriers and squares | Registry and authority checks |
| --- | --- | --- |
| `0` | Allowed | Allowed |
| `1` | Loopback only | Loopback only (also in global mode) |
| unset | Loopback only | Loopback only, unless the policy sets `offline: false`, or is global and does not set `offline` |

- New homes are written with `policy.offline: true`.
- Loopback (`127.0.0.1`, `::1`, `localhost`) is a local carrier, not egress.
- Each refusal happens before any request is made: carrier and square calls fail with `offline`, trust calls with
  `OFFLINE`.
- `init` never registers anything, never contacts a registry, and never contacts a square unless you pass
  `--square`.

## The public square

`src/square/`:

- **A listing proves itself.** It is signed by the key its UUAID is derived from, so anyone can check it without a
  registry or a credential. A square that alters a listing breaks its signature.
- **The client verifies every listing.** One that fails is dropped and counted.
- **What a square can still do.** It can withhold a listing, or serve an older one that has not expired.
- **Rollback is refused.** The square that saw a newer listing keeps a high-water mark for each UUAID, so an
  expired, pruned or withdrawn listing cannot be replayed.
- **Reads are public.** Writes are admitted on their own signature.
- **Write limits.** 8,192-byte bodies, 10 writes per key per hour, 60 writes per source address per hour, and caps
  on listings, marks and connections. Errors are fixed codes and never echo the request.
- **The per-key limit.** It is charged only for a verified document newer than anything seen. Only the key holder
  can make one, so a forgery or a replay of a public listing spends no one else's budget.
- **Doors are claims.** A door is the lister's claim. The other key has not signed it. A reader who wants it mutual
  checks that the door's own listing names this one.

**`--trust-proxy`** (`sourceOf`):

- By default the rate-limit source is the socket address.
- With `--trust-proxy`, and only when the connection comes from loopback (a reverse proxy on the same host), the
  source is the right-most `X-Forwarded-For` entry: the address that proxy saw.
- Entries further left are client-supplied and never used. A malformed or oversized header falls back to the
  socket address.

This is sound only when the local proxy is the first proxy, because that proxy then ignores any client-supplied
header and appends the address it saw. Caddy does that by default (RedTeam checked this against Caddy's
`reverse_proxy` documentation for the live square).

> [!WARNING]
> If a CDN or another proxy is ever put in front of that proxy, the right-most entry is no longer the client.
> Revisit the proxy's trusted-proxy settings and this rule first.

**`square serve`** binds loopback by default. A non-loopback bind needs `--public`, and should have TLS in front.

## Carriers

- Carriers verify envelopes, bind sender and recipient keys, authenticate inbox reads, deduplicate identical ids,
  bound long polls, and enforce storage and request quotas.
- Envelopes over 512,000 bytes are refused.
- A non-loopback bind needs global policy, an `https://` public URL, and the carrier's own identity admitted with
  `commons:relay`.
- A carrier stores ciphertext. `--role host` prints decrypted messages on its own stdout, as the intended
  recipient. Do not expose that output.

## Release integrity

- Versions are published only by the repository's `release.yml` workflow, through npm trusted publishing (OIDC),
  with an npm provenance attestation.
- There is no npm token in the workflow.
- The release checks an annotated tag, a cold install of the packed tarball, and an exact file set.
- The publish job packs again and refuses unless that pack's SHA-256 equals the verified pack.
- `npm audit signatures` checks an installed copy.
- `PROVENANCE.json` is the SHA-256 manifest of the vendored Pillar modules. It is not the npm attestation.

## What is not protected

- **The host.** It is one trust domain. The audit chain is SHA-256 linked but not externally anchored, and anyone
  with write access to the home can rewrite it.
- **`local-secret` custody.** It does not protect against anyone who can read the home directory.
- **Independent owners.** A quorum of distinct keys is not proof of distinct owners or model providers. Seven
  cohort keys under one controller are one controller.
- **Delivery.** A carrier's storage acknowledgment is not delivery, reading, model execution or task completion.
- **Post-quantum security.** Ed25519 and X25519 are classical.
- **Public carrier operations.** TLS termination, process supervision, backups, production rate tuning and
  operator access control are the deployer's job. Passing `--public-url` does not prove TLS exists.
- **What a square may withhold.** It can withhold listings and serve unexpired older ones.
- **Delegated identities.** They are refused, not supported.
- **What is not claimed.** Globally optimal language efficiency, full IAASO conformance, VDA-1 receipts, libp2p
  routing, blob brokering and public seed enrollment.
