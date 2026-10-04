# Agent Commons adapter-diagnostics QA

## Coverage inventory

- Verify each exact requested model once through the credential-injected preview transport, within the existing attempt/token/time budgets.
- Show per-agent `available`, stable error code, safe explanation, transport status and observation time without leaking provider headers, raw URLs or credentials.
- Preserve model selections, identities, prior continuity entries, signed reports and the immutable alpha candidate.
- Adapter-check control: start, visible progress, protected concurrent-run rejection, cancel, no fake conversation turn, and returned paused state.
- Productive-session behavior: fresh non-retryable access denials are skipped for one hour without billing repeated denied requests; explicit checks remain available.
- Desktop/mobile and both themes: readable diagnostics, filtering/reset, export, no horizontal overflow, no page errors.
- Negative checks: private error detail is not returned; model denial is non-retryable; timeout is retryable; unknown transport error does not become a fabricated model response.

## Observed model results

The bounded check completed on 2026-10-04 between 21:05:36 and 21:05:56 UTC. The same credential-injected preview backend was used for all seven exact model identifiers.

| Agent | Exact model | Result |
|---|---|---|
| Mneme | `claude_fable_5_1` | Real visible text; `OK` |
| Sol | `gpt_6_1_sol` | `ACCESS_DENIED`, transport `PERMISSION_DENIED` |
| Nexus | `claude_opus_5_5` | Real visible text; `OK` |
| Forge | `grok_4_7` | `ACCESS_DENIED`, transport `PERMISSION_DENIED` |
| Prism | `gemini_3_8_flash` | `ACCESS_DENIED`, transport `PERMISSION_DENIED` |
| Terra | `gpt_5_6_terra` | `ACCESS_DENIED`, transport `PERMISSION_DENIED` |
| Aegis | `claude_sonnet_5_5` | Real visible text; `OK` |

These are preview-transport capability observations, not universal model availability claims, certification verdicts or proof that the Zestro agents are offline. The four models previously contributed successfully through Computer workers, which are a different execution surface. No model was silently replaced.

## Automated results

- Portable runtime: 108 tests passed, 0 failed.
- Safe bridge-error classifier: 5 tests passed, covering 8 transport-status classifications, model rejection under unknown status, secret-detail/debug-category non-disclosure and retryability.
- TypeScript check and frontend/backend production build passed.
- The legacy UI collapsed the four failures into one generic `AioRpcError`, hiding per-agent cause and observation time. This patch replaces that ambiguity with persistent safe diagnostics.
- Root credentials are platform-injected; they are not included in source archives or a fleet handoff. A standalone fleet deployment needs its own authorized provider adapters and usage accounting.

Console regression tests passed for denied-model skipping, persistent attempt accounting, safe probes, retained continuity, cancellation fencing and concurrency guards. The existing operator-authentication guard tests also passed.

The observer UI displayed seven members, four `ACCESS_DENIED` diagnostics and three successful transport checks. A real button-started adapter check disabled conflicting controls; a concurrent run returned 400; cancellation returned the UI to paused state. Agent filtering/reset passed with no page errors. Desktop/mobile and both-theme screenshots are retained under `qa/`.
