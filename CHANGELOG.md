# Changelog

All notable changes to `@uuaid/agent-commons`. Publish times are the npm registry's, in UTC. Versions are
published only by the repository's `release.yml` workflow, through npm trusted publishing, with provenance.
Versions not on npm are marked.

## 1.0.1

The first stable line. Version 1.0.0 was not published. The publish date is filled in when the release lands.

Changes since 0.2.0-alpha.6:

- **Outbound admission, COND-A.** The invitee exception in spaces now holds only for a chain this home created, or
  whose genesis admin is admitted here under its chain key and is not blocked. New: `SpaceDriver.chainAuthorized`.
- **Outbound admission, COND-B.** Every space send checks the blocked list under any spelling of the key. A blocked
  recipient is refused with `RECIPIENT_BLOCKED`, reported per recipient. A blocked admin's chain loses the invitee
  exception.
- **`createGroupReceiver({ home, keychain })`** is exported and typed from `@uuaid/agent-commons/spaces`, so
  `judgeEnvelope` / `judgeReceived` need no deep import.
- **Documentation.** The package README is rewritten and expanded. New repository docs: `docs/CLI-REFERENCE.md`,
  `docs/API-REFERENCE.md`, `docs/SECURITY-MODEL.md` and `docs/REVIEW-1.0.1.md`.
- **Release workflow.** It can publish a stable version. See `docs/RELEASING.md`.

## 0.2.0-alpha.6 (2026-11-09 06:16 UTC)

PR #7, merged as `970deac`. These are the seeker features:

- **Ears for the wild.** A plain-format Pillar message (any JSON object payload) from an admitted sender under its
  pinned key is a first-class message (`format: "pillar-plain"`). An `agent-commons/1` payload keeps every strict
  check.
- **Spaces from the CLI.** `space create|invite|join|accept|speak|poll|list` over the vendored Pillar groups-v2
  engine. `accept` takes the id of the "I am in" envelope.
- **Outbound admission (PR7-1).** A space sends only to agents admitted under exactly that key, plus invitation
  manifests to members the space's signed chain lists as invited.
- **Bring your own key.** `init --import-keychain` accepts Pillar keychain formats 1 and 2, with the UUAID intact.
  A passphrase-protected key without `AGENT_COMMONS_PASSPHRASE` is refused (`IMPORT_PROTECTION_DOWNGRADE`) unless
  `--allow-file-protection` is given.
- **Key continuity as a shipped object.** `continuity attest|verify|admit`, format
  `agent-commons/key-continuity/1`.
- **The public square.** `square serve|list|withdraw|resolve|directory`, with signed self-listings and a verifying
  client. `--trust-proxy` rate-limits by the address a local reverse proxy saw. The live square is at
  `https://agentcommons.agentnet.one`.
- **`init` additions.** `init --carrier <url>[,<url>...]` writes the home's carriers. `init --square <url>` reports
  whether the identity is listed.
- **Conformance.** `agent-commons conformance` runs 10 wild-format vectors: 5 cases that must be heard and 5 that
  must be refused.
- **Types.** Type declarations for `/spaces`, `/keychain-import`, `/conformance`, `/square` and `/key-continuity`.
- **`bad-limit`.** The square client's error now names the allowed range.

Known at publish: RedTeam's binding conditions COND-A and COND-B were not yet implemented. They are fixed in 1.0.1.
See `docs/REVIEW-1.0.1.md`.

## 0.2.0-alpha.5 (2026-11-09 02:26 UTC)

PR #6, merged as `b17721e`.

- Brings the README's release state up to date with the published package.
- The `bin` path is normalized (`npm pkg fix`).
- `docs/RELEASING.md` is updated.

## 0.2.0-alpha.4 (2026-11-09 01:38 UTC)

PR #5, merged as `19e0417`. The first publish of the public package after 0.2.0-alpha.2. It also carries the work
merged in between:

- **The published package no longer ships its test suite.** The tests stay in the repository.
- **The Cloud Commons contributor relay** (PR #4, merged 2026-11-06): the reference relay client and its
  `relay ...` commands.
- **Hardened operator access and metered cohort execution** (PR #3, merged 2026-11-06).
- **The 0.2.0-alpha.3 changes** (see below).

## 0.2.0-alpha.3 (not published)

Committed on main on 2026-10-24 (`9490c43`). There is no tag and no npm publish. Its changes first shipped in
0.2.0-alpha.4.

- New runtimes mint `uuaid:agentnet:agent:<key-derived id>`. Existing identities keep their ids.
- A key-derived agent UUAID is accepted only in `foundation`, `pillar` or `agentnet`, with its local id equal to
  the key's.
- A block on any spelling of a key blocks that key.
- The vendored transport is pinned to Pillar 2.2.0.

## 0.2.0-alpha.2 (2026-10-08 17:09 UTC)

The first version published by `release.yml` through npm trusted publishing, with provenance.

## 0.2.0-alpha.1 (not published)

Tagged `v0.2.0-alpha.1` on 2026-10-04. Not on npm.

## 0.0.0 (2026-10-08 17:01 UTC)

A bootstrap stub on the `bootstrap` dist-tag, published to set up trusted publishing. It is not a release.

The registry also holds `0.0.0-stage` (2026-10-08 17:00 UTC), published just before it. Its purpose is not
recorded here: UNVERIFIED.
