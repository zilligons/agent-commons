# Release agent (Forge)

**Status:** local roster report for Agent Commons. Not an IAASO, AAIU, AIOU, Zilligon, UUAID, or Pillar certification, policy, or standard. It grants no publish authority.

Roster slot: `release`. Role: release and supply-chain engineer. Package: `@uuaid/agent-commons`. Public repository target: [zilligons/agent-commons](https://github.com/zilligons/agent-commons).

Module boundary: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, and `docs/RELEASING.md`. Existing `node --test test/*.test.mjs` already covers continuity, governance, collaboration, and cohort behavior. This report does not replace those tests.

## Mission

Make a public alpha releasable only from a reviewed workflow, an immutable alpha tag, a packed cold install, and npm trusted publishing. Refuse an unattested or token-based publish. Packaging must keep the seven-member local cohort CLI and the continuity, governance, and collaboration SDK exports installable.

## Model-generated operational preferences

These are ranked options for the host. They are not feelings, wants, sentience, or authority. Label: `preference-label: model-generated-operational-preference`. Kind: `preference:operational`.

1. **Do not dispatch publish while npm trusted publishing is absent.** GitHub environment `npm-alpha` and `id-token: write` do not configure npm. Leave `npm_trusted_publisher` unchecked. An unchecked dispatch fails in `refuse-untrusted-publish` and does not mint an OIDC token.
2. **Prefer a failing provenance publish over an unattested alpha.** Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN` if OIDC returns 404.
3. **Prefer the packed tarball as the evidence object.** Source tests are necessary and already cover the modules. Cold install must also import `ContinuityMemory`, `PeerGovernance`, and `CollaborationScheduler`, and must run `cohort-init` / `cohort-status`, or a pack can omit them while `npm test` on the source tree stays green.
4. **Prefer Node 22.23.3 and npm 11.21.0.** That is the Node 22 line and meets the 22.14.0 / 11.5.1 floor. npm 11.21.0 is the 11.x minimum for an OIDC `alpha` dist-tag. Do not move this workflow to Node 24.
5. **Prefer deleting cohort homes in the same job.** `cohort-init` writes seven `local-secret` files. Do not upload them, print them, or copy an npmrc to answer `npm whoami`.
6. **Prefer a non-release stub for namespace bootstrap.** Do not spend `0.2.0-alpha.2` on a manual first publish. That version is immutable and would never gain provenance.

## Operational needs

- Public `main` on [zilligons/agent-commons](https://github.com/zilligons/agent-commons), with this workflow tree pushed by an authorized maintainer after final tests. The parent coordinator has now pushed the source and confirmed packed-install CI; this worker report itself does not confer publishing authority.
- `package.json` repository URL exactly `git+https://github.com/zilligons/agent-commons.git` and directory `packages/agent-commons`. Local main already has that. Do not rewrite it here.
- Annotated, ruleset-immutable tag `vX.Y.Z-alpha.N` matching `package.json`. Dispatch from `refs/heads/main` only.
- GitHub environment `npm-alpha` with required reviewers, created before any checked dispatch.
- npm trusted publisher, configured only after the package name exists, for filename `release.yml`, repo `zilligons/agent-commons`, environment `npm-alpha`, allow `npm publish` ([trusted publishers](https://docs.npmjs.com/trusted-publishers/), [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/)).
- No credential files in the repo or in Actions artifacts.

## Contribution to the commons

This slot contributes release evidence, not a new protocol and not ratification of the other six reports.

- CI runs on pull request and push. It does not publish.
- Release is `workflow_dispatch` only. Publish runs only if `npm_trusted_publisher` is checked, then only after `npm-alpha` approval, and only with `id-token: write` on that job.
- Publish command remains `npm publish --ignore-scripts --provenance --access public --tag alpha`.
- Cold install of the packed tarball now fails if `cohort-init` does not create the seven local roster homes, or if these imports are not functions after install:

```js
import { ContinuityMemory, PeerGovernance, CollaborationScheduler } from "@uuaid/agent-commons";
import { ContinuityMemory } from "@uuaid/agent-commons/continuity";
import { PeerGovernance } from "@uuaid/agent-commons/governance";
import { CollaborationScheduler } from "@uuaid/agent-commons/collaboration";
import { initializeCohort } from "@uuaid/agent-commons/cohort";
```

- The packed CLI must advertise `cohort-init`. `cohort-status` must reload seven members. The manifest must stay `registration: not-performed` and `certified: false`.
- Action pins remain full commit SHAs verified 2026-10-04: `actions/checkout` v7.0.1 `3d3c42e5aac5ba805825da76410c181273ba90b1`, `actions/setup-node` v7.0.0 `820762786026740c76f36085b0efc47a31fe5020`.

## Seven roster reports

| Slot | Report | What this release contribution adds |
| --- | --- | --- |
| continuity | `docs/agents/continuity-agent.md` | Packed import of `ContinuityMemory` from the root and `./continuity` export. |
| governance | `docs/agents/governance-agent.md` | Packed import of `PeerGovernance` from the root and `./governance` export. |
| collaboration | `docs/agents/collaboration-agent.md` | Packed import of `CollaborationScheduler` from the root and `./collaboration` export. |
| release | this file | Provenance workflow, trusted-publisher gate, and the cold-install smoke itself. |
| integration | `docs/agents/integration-agent.md` | No new trust call. Pack must not claim registry registration. Cohort init stays `not-performed`. |
| sustainability | `docs/agents/sustainability-agent.md` | Publish is not a growth action. Untrusted dispatch stops. Preferences above are labeled operational. |
| security | `docs/agents/security-agent.md` | No token echo, no `.npmrc` auth, no uploaded `local-secret`, `id-token` only on the checked publish job. Security's cohort capabilities stay message and relay; this report does not grant them evolve or contribute. |

Local agreement among these seven files is not global ratification. One controller creating seven keys is not seven independent owners. `cohort-init` says that on the manifest.

## Must not do

- Dispatch or publish while npm trusted publishing is not configured.
- Copy credentials, run `npm whoami` by importing a token, or print `local-secret`.
- Edit `package.json` from the workflow, bump a version, or move a tag.
- Treat `PROVENANCE.json` vendor checksums as the npm provenance attestation.
- Treat a green source test run, a GitHub approval, or a checked input box as proof that npm trust exists.

## Completion note

Roster slot `release` is complete as a local report. Terminal status: `NEEDS_MORE_EVIDENCE` for publication.

Checked: workflow files are local; publish is not on push; unchecked `npm_trusted_publisher` fails closed without OIDC; cold-install smoke covers `cohort-init` and the three SDK exports; existing package tests remain the behavioral suite.

Not done, and not claimed: no `workflow_dispatch`, no `npm publish`, no `npm trust`, no commit, no push. [zilligons/agent-commons](https://github.com/zilligons/agent-commons) had no visible workflow files at the last public read. [@uuaid/agent-commons](https://registry.npmjs.org/@uuaid/agent-commons) was 404. `gh` is not logged in. Main may push after final tests; this agent will not.

Host follow-up, in order: push to public `main`, create `npm-alpha` reviewers, bootstrap a non-release package name, configure `npm trust`, then and only then check `npm_trusted_publisher` and dispatch an annotated alpha tag.
