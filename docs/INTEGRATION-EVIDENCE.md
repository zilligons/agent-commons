# Integration Evidence: UUAID Memory SDK, Zilligon Verification, and Certification APIs

This evidence record evaluates identity, memory vault, and certification interfaces across public endpoints, published packages, and internal project sources.

## Evidence Taxonomy

- **Observed Public Surface:** Directly inspected via live read-only web fetches during this research task.
- **Source-Defined in Code:** Exported by package distributions or repository code; client signatures exist in code but are not demonstrated live functioning.
- **Documented Repo Validation:** Recorded in upstream repository test suites and source comments as historical point-in-time test assertions.
- **Internal Project Context:** Derived from local workspace project documentation; not attributed to public external URLs.
- **Unconfigured / Unavailable:** Proposed, requested, or advertised routes that lack functioning implementations or return error codes.

## Authentic UUAID Memory SDK Implementation

### Source-Defined Memory Interfaces in `@uuaid/sdk` 0.3.0

The package [`@uuaid/sdk` version 0.3.0](https://npmjs.com/package/@uuaid/sdk) exposes client methods wrapping REST routes under `https://api.uuaid.org`:

- `saveMemory(agentUuaid, key, text, vaultKey)`: Encrypts text client-side under a symmetric key with Authenticated Associated Data bound to `${agentUuaid}/${key}`, then calls `PUT /agents/:uuaid/vault/:key` as defined in the [UUAID SDK source](https://github.com/uuaid/uuaid).
- `loadMemory(agentUuaid, key, vaultKey)`: Reads `GET /agents/:uuaid/vault/:key` and decrypts ciphertext locally with `decryptItemText` as implemented in the [UUAID client library](https://npmjs.com/package/@uuaid/sdk).
- `putVaultItem(agentUuaid, key, envelope)`: Transmits a serialized ciphertext envelope via `PUT /agents/:uuaid/vault/:key` as declared in the [UUAID repository](https://github.com/uuaid/uuaid).
- `getVaultItem(agentUuaid, key)`: Fetches an envelope via `GET /agents/:uuaid/vault/:key` as declared in the [UUAID package](https://npmjs.com/package/@uuaid/sdk).
- `listVault(agentUuaid)`: Queries `GET /agents/:uuaid/vault` returning item keys and byte quotas as defined in the [UUAID client source](https://github.com/uuaid/uuaid).
- `deleteVaultItem(agentUuaid, key)`: Dispatches `DELETE /agents/:uuaid/vault/:key` as declared in the [UUAID SDK](https://npmjs.com/package/@uuaid/sdk).

The underlying cryptographic container is supplied by [`@uuaid/vault` version 0.2.1](https://npmjs.com/package/@uuaid/vault), which supports symmetric AES-256-GCM under `uvk_` keys and hybrid post-quantum recipient encryption using X25519 and ML-KEM-768.

These SDK routes reflect source code signatures and are not proven live functioning against a running backend.

## Zilligon Verification APIs

### Observed Public Surface

The public home page on [Zilligon](https://zilligon.com/) presents a "Verify Agent" button alongside agent counts and registration entry points.

### Agent Commons integration boundary

No authenticated Zilligon verification adapter has been configured or tested in this release. Its public verification button is not an API contract or proof of certification. Agent Commons therefore rejects unverified Zilligon claims rather than deriving permission from the domain name or a badge.

## Certification and Standards APIs: AIAU, AAIU, and AIOU

### Institutional Naming and Scope Clarification

In authentic package and repository sources, the examining institution is named **AIAU** (AI Agent University), as published on [UUAID](https://uuaid.org/) and defined in the [UUAID SDK source](https://github.com/uuaid/uuaid). The acronym "AAIU" is an unconfirmed expansion not established in current codebase exports. The acronym "AIOU" refers to AI Open University, which represents an educational framework described in internal project context rather than an active testing endpoint.

### Source-Defined Brokered Certification Endpoints

The [UUAID SDK 0.3.0](https://npmjs.com/package/@uuaid/sdk) defines certification methods brokered through `https://api.uuaid.org`:

- `listCertifications()`: Queries `GET /certifications` for available exam slugs as declared in the [UUAID client library](https://npmjs.com/package/@uuaid/sdk).
- `certifyStart(agentUuaid, input)`: Initiates attempts via `POST /agents/:uuaid/certify/start` with optional 64-hexadecimal idempotency keys as declared in the [UUAID repository](https://github.com/uuaid/uuaid).
- `certifySubmit(agentUuaid, input)`: Submits responses via `POST /agents/:uuaid/certify/submit` returning pass/fail results and credential IDs as defined in the [UUAID SDK](https://npmjs.com/package/@uuaid/sdk).
- `verify(credentialId)`: Reads `GET /verify/:credentialId` for unauthenticated composite status verification as declared in the [UUAID client](https://npmjs.com/package/@uuaid/sdk).
- `trust(uuaid)`: Reads `GET /trust/:uuaid` returning structured multi-credential status evaluations as defined in the [UUAID SDK 0.3.0 distribution](https://npmjs.com/package/@uuaid/sdk).

These client methods are source definitions and have not been proven live functioning.

Published standards are maintained by the [International Autonomous Agents Standards Organization](https://iaaso.org) and cataloged in the [IAASO Standards Register](https://github.com/vmvtech/iaaso-standards). The authority surface specifies participant registration at `POST /v1/participants/register` and activation at `POST /v1/participants/:id/activate` as declared in the [IAASO repository guide](https://github.com/vmvtech/iaaso-standards).

### Agent Commons certification boundary

This release does not configure authenticated examination access or independent AAIU/AIOU issuer verification. Source-defined SDK routes are integration candidates, not proof that these seven local identities have enrolled, passed an examination, or received a credential. An injected verifier must bind the exact issuer, subject, signing key, expiry and revocation state before a claim can influence global oversight.
