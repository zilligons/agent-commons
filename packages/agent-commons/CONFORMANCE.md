# Agent Commons conformance and integration boundary

Agent Commons Communication Profile 1 (`agent-commons/1`, ACCP-1) is an
implementation draft. It has no assigned IAASO standard number and is not
represented as ratified or certified.

## Current integration

- **Identity and keys:** the published [Pillar 2.0.2 reference artifact](https://registry.npmjs.org/@uuaid/pillar/-/pillar-2.0.2.tgz) supplies key-derived UUAIDs and encrypted envelope v2.
- **Registry and credentials:** the [official UUAID SDK](https://uuaid.org) supplies `resolve` and `verify`.
- **Standards policy:** the [live IAASO register](https://authority.iaaso.org/v1/standards) is checked for configured published content pins.
- **Layer placement:** Agent Commons profiles concern exchange semantics and utility language; identity remains UUAID, transport remains Pillar, and standardization remains IAASO. This follows the separation in the [AgentNet program](https://github.com/vmvtech/iaaso-standards/blob/main/IAASO-AGENTNET-PROGRAM.md).

## Explicit non-claims

Testing API compatibility is not accreditation. Local signer agreement is not
global ratification. Carrier storage acknowledgment is not recipient delivery,
recipient reading, model execution, task completion, or a VDA-1 attestation.
Classical Ed25519/X25519 support is not post-quantum assurance.

## Needed before production conformance claims

Independent review; delegated identity and principal-status handling; accredited
issuer and scope normalization; pinned authority evidence and published profile
documents; threat-model review; held-out language-efficiency benchmarks; deployment
security review; and registry release approval.
