# Releasing `@uuaid/agent-commons`

Public repository: [zilligons/agent-commons](https://github.com/zilligons/agent-commons).
Package: `@uuaid/agent-commons`, directory `packages/agent-commons`.

This document is the release procedure, not a claim that an npm version has been published. The coordinator created the authorized [public repository](https://github.com/zilligons/agent-commons), configured its `npm-alpha` environment with an owner-review gate, and installed an alpha-tag update/deletion ruleset with an explicit administrator bypass. Exact source-publication and CI results are recorded in `QA-COHORT.md`; the npm publishing identity remains unconfigured.

`PROVENANCE.json` in the package is a vendored Pillar checksum manifest. It is not the npm registry provenance attestation.

## What runs automatically

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on pull requests, pushes to `main`, and alpha tags. It tests the package and cold-installs the packed tarball. It has `contents: read` only. It does not publish, and it must not be given `id-token: write`.

[`.github/workflows/release.yml`](../.github/workflows/release.yml) does **not** run on push. Publish is `workflow_dispatch` only. A tag push is not a publish.

## Toolchain

npm trusted publishing requires Node.js 22.14.0 or newer and npm CLI 11.5.1 or newer ([trusted publishers](https://docs.npmjs.com/trusted-publishers/)). These workflows pin Node **22.23.3** and npm **11.21.0**. That is the Node 22 line, not the Node 24 example in some npm pages.

Node 22.23.3 was the newest 22.x on the [Node index](https://nodejs.org/dist/index.json) on 2026-10-04 and bundles npm 10.9.9, so the workflows install npm 11.21.0. npm 11.21.0 is the newest 11.x and the minimum 11.x that can set an OIDC dist-tag ([trusted publishers](https://docs.npmjs.com/trusted-publishers/), [npm 11.21.0](https://registry.npmjs.org/npm/11.21.0)). The alpha dist-tag is why 11.5.1 alone is not enough.

`package.json` `engines.node` is still `>=22.13.0`. These workflows do not edit `package.json`. CI will not install Node 22.13.

## Actions are pinned to full commit SHAs

Verified 2026-10-04 from public GitHub reads. Both tags were lightweight commit refs, so the SHA is the commit SHA:

| Action | Tag | Commit |
| --- | --- | --- |
| `actions/checkout` | [v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-node` | [v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0) | `820762786026740c76f36085b0efc47a31fe5020` |

Resolution URLs: [checkout commit](https://api.github.com/repos/actions/checkout/commits/v7.0.1), [setup-node commit](https://api.github.com/repos/actions/setup-node/commits/v7.0.0).

`setup-node` is not given `registry-url`. That input writes a project `.npmrc` that reads `NODE_AUTH_TOKEN`. These workflows use an empty npm userconfig and `https://registry.npmjs.org/` with no auth token.

Runners are `ubuntu-24.04` and must report `RUNNER_ENVIRONMENT=github-hosted`. Self-hosted runners cannot mint the OIDC identity npm accepts ([trusted publishers](https://docs.npmjs.com/trusted-publishers/)).

## Immutable dispatch version

The release input `version` is required and has no default. It is not a bump. The workflow rejects anything other than `X.Y.Z-alpha.N` with no `v` prefix, no `latest`, and no other prerelease.

Dispatch must be from `refs/heads/main`, so the reviewed workflow file runs. The job then checks out only the annotated tag `v<version>`. A branch HEAD is refused. The tag must be an annotated tag (`git cat-file -t` is `tag`). The workflow does not create, move, or delete tags.

`package.json` and `package-lock.json` must already equal that version. The workflow will not rewrite them.

The npm dist-tag is the literal `alpha`, not an input. `publishConfig.tag` must already be `alpha`, `access` must be `public`, and `provenance` must be boolean `true`.

The publish job packs again and refuses to publish unless the tarball SHA-256 matches the pack that passed the cold install. It also refuses if the checked-out tag commit is not the verified commit. `github.sha` on a `workflow_dispatch` from `main` is the branch SHA, not the tag, so the workflows compare `git rev-parse HEAD` after the tag checkout.

GitHub cannot make a tag immutable from this file. The configured alpha-tag ruleset blocks ordinary update and deletion, but the administrator's documented bypass preserves owner authority. Annotated tags and workflow digest checks are necessary and are not a claim of absolute immutability.

## Cold install

CI and the release verify job, which have no `id-token` permission:

1. `npm ci --ignore-scripts` and `npm test` in `packages/agent-commons`.
2. `npm pack` and refuse a tarball that contains `.npmrc`, `.env`, `local-secret`, `identity.json`, key material, or `node_modules`.
3. Install that tarball in `$RUNNER_TEMP` with an empty npmrc.
4. Run the packaged tests. Those tests already cover continuity, governance, collaboration, and cohort behavior. The cold install additionally imports `ContinuityMemory`, `PeerGovernance`, and `CollaborationScheduler` from the package root and from `./continuity`, `./governance`, and `./collaboration`, so a pack that omits those modules fails before publish.
5. Run packed `cohort-init --target zilligon.com` and `cohort-status`. Require the seven roster ids, `registration: not-performed`, and `certified: false`. Delete that home in the same step. It contains seven `local-secret` files and must not be printed or uploaded.
6. Also run `init --target zilligon.com` and `doctor`, then delete that home.

`doctor` currently hardcodes `packageRelease` as `0.2.0-alpha.1` in `bin/agent-commons.mjs`. The release verify job fails if that string does not equal the dispatched version. Do not hide that by skipping the check. A later alpha needs a separate source change; this procedure does not edit that file.

## Publish job

The publish job is the only job with `id-token: write`, and it runs only when the dispatch input `npm_trusted_publisher` is true. That box is an operator attestation that `npm trust github` already exists for `release.yml`, `zilligons/agent-commons`, and environment `npm-alpha`. It is not proof. Leave it unchecked until that npm configuration exists. An unchecked dispatch fails in `refuse-untrusted-publish` and does not request an OIDC token or wait on `npm-alpha`.

Do not dispatch a publish while the trusted publisher is missing. This tree has not been dispatched.

When the input is true, the publish job waits on the GitHub environment `npm-alpha` before any of its steps. That approval is a GitHub deployment gate. It does not configure npm, and it does not by itself authenticate to the registry.

Publish command, with scripts ignored so `prepublishOnly` does not run beside the OIDC permission:

```bash
npm publish --ignore-scripts --provenance --access public --tag alpha --registry https://registry.npmjs.org/
```

`--provenance` is explicit even though trusted publishing can generate provenance without the flag ([generating provenance statements](https://docs.npmjs.com/generating-provenance-statements/)). Provenance is generated only for a public repository and a public package ([trusted publishers](https://docs.npmjs.com/trusted-publishers/)). The workflow fails closed unless repository visibility is `public` and the server is `https://github.com`.

There is no `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or other `secrets.*` reference. If those variables are present, the job refuses and prints the variable names only. Do not add a token fallback if OIDC fails.

## Repository metadata

Provenance requires `repository.url` to match this GitHub repository ([trusted publishers](https://docs.npmjs.com/trusted-publishers/)). The release workflow accepts only:

```json
{
  "type": "git",
  "url": "git+https://github.com/zilligons/agent-commons.git",
  "directory": "packages/agent-commons"
}
```

Local `main` already has that object. This procedure does not edit `package.json`. If a tag's `package.json` lacks it, dispatch fails before `npm publish`.

## npm configuration is still required

GitHub environment approval and `id-token: write` are not enough. npm must have a trusted publisher whose claims match the job that mints the token ([trusted publishers](https://docs.npmjs.com/trusted-publishers/), [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/)):

| Claim | Required value |
| --- | --- |
| Organization or user | `zilligons` |
| Repository | `agent-commons` |
| Workflow filename | `release.yml` (filename only, not the workflow `name:`) |
| Environment | `npm-alpha` |
| Allowed action | `npm publish` |

All of those fields are case-sensitive. `npm trust` can be attached only to a package that already exists, and it requires account 2FA plus write access ([npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/)). `@uuaid/agent-commons` does not exist yet, so trusted publishing cannot be configured, and the first OIDC publish will fail. Do not "fix" that by printing or storing a token.

### Namespace

The `@uuaid` scope already has other packages. This package name is still absent. Scope existence does not create `@uuaid/agent-commons`, and it does not grant this workflow publish rights.

### Bootstrap without burning the release version

npm versions are immutable. Do not manually publish `0.2.0-alpha.1`, or any version you want attested, as the stub. A manual first publish of that version can never be replaced by a provenance release.

An authorized npm namespace administrator, through an authenticated publishing environment outside this workflow:

1. Confirm the already-configured GitHub environment `npm-alpha` has its required owner reviewer before dispatch. The workflow file alone cannot declare reviewers.
2. Interactively `npm login` as an `@uuaid` publisher with 2FA. Do not paste a token into chat, issues, Actions logs, git, or this repository. Do not copy an npmrc or token into the sandbox.
3. From a temporary directory, not this package, publish a non-release stub such as `0.0.0` with `--access public` and a non-default tag such as `bootstrap`. Give that stub the same repository URL. Do not use the alpha version.
4. Configure trust. npm CLI 11.15.0 or newer is required; 11.21.0 is sufficient:

```bash
npm trust github @uuaid/agent-commons \
  --file release.yml \
  --repo zilligons/agent-commons \
  --environment npm-alpha \
  --allow-publish
```

5. Once trust is tested, consider restricting token publication according to the namespace owner's policy. Do not revoke an existing shared credential or log out a user's session without explicit authorization:

```bash
npm access set mfa=publish @uuaid/agent-commons
npm logout
```

Do this only after trust works. Setting `mfa=publish` before the trusted publisher exists blocks CI and leaves only interactive 2FA publish.

6. Confirm the configured alpha-tag protection ruleset and its explicit owner bypass. Use the reviewed workflow on `main` and an annotated `vX.Y.Z-alpha.N` tag on the commit whose package version exactly matches. Do not move a release tag.
7. Let CI pass on that commit. Then `workflow_dispatch` from `main` with that exact version. Approve `npm-alpha` only after the verify log shows no credential material.
8. Confirm the registry version from a public read. Do not run `npm whoami`, `npm token`, `npm config list`, `env`, or `printenv` to confirm it.

## No secret echo

- Workflows never print environment dumps or npm config.
- Cold-install secrets are deleted and not uploaded. There are no artifact upload steps.
- Checkout uses `persist-credentials: false`.
- A failed OIDC publish is a blocker, not a prompt to echo `NPM_TOKEN`.
- If a token appears in a log, revoke it. Do not copy the log into git.

The coordinator attempted a read-only local `npm whoami` using the user's existing session, but the device sandbox blocked network access. That result does not establish login state, and credentials must not be copied here to work around it.

## Remaining authorization boundary

The workflow files do not create npm trust, provision a bootstrap version, or read a local npm credential. Source publication is separately authorized and coordinated. No bootstrap stub or npm version was published, and the provenance workflow will not be dispatched until a valid publishing identity exists.
