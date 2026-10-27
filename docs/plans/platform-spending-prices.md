# Platform spending price ceilings

Author: the implementation author; 2026-10-27 06:02 PDT.
Served-by: UNVERIFIED; exact Codex response model is not provable from logs.

The immutable table in `server/adapters/platform-pricing.ts` copies the eight
official-source rows compiled from the provider pricing pages linked below. Retrieval and
verification date: **2026-10-27, America/Los_Angeles**. These are conservative
reservation estimates, not invoices. No provider request or provider key is needed
to read or validate this table.

| Exact model | Nanodollars/token | USD/million tokens | Ceiling basis and official source |
|---|---:|---:|---|
| `gpt-6.1-sol` | 99000 | 99.00 | Highest published long-context Ultrafast text output, including 10% regional uplift. [OpenAI pricing](https://developers.openai.com/api/docs/pricing) |
| `gpt-5.6-terra` | 19800 | 19.80 | Standard output 12 × long-context 1.5 × regional 1.1. The transport explicitly sends `service_tier: "default"`; premium modes are outside this ceiling. [Terra model](https://developers.openai.com/api/docs/models/gpt-5.6-terra) |
| `claude-fable-5-1` | 55000 | 55.00 | Output 50 × US inference 1.1, above input/cache-write rates. [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| `claude-opus-5-5` | 44000 | 44.00 | Fast output 40 × US inference 1.1, above input/cache-write rates. [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| `claude-sonnet-5-5` | 11000 | 11.00 | Output 10 × US inference 1.1, above input/cache-write rates. [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| `gemini-4-argon` | 36000 | 36.00 | Announced Priority output effective December 1; above current 18. Thinking is included. [Google pricing](https://ai.google.dev/gemini-api/docs/pricing) |
| `gemini-3.8-flash` | 13500 | 13.50 | Announced Priority output effective January 1; above current 6.75. Thinking is included. [Google pricing](https://ai.google.dev/gemini-api/docs/pricing) |
| `grok-4.7` | 12000 | 12.00 | Historical, currently unregistered route; highest published long-context text output. [xAI pricing](https://docs.x.ai/developers/pricing) |

One US dollar equals 1,000,000,000 integer nanodollars. Each ceiling applies to
every reserved token, including input and output, rather than assuming a cheaper
token mix. The fixed Gemini transports do not use explicit cache storage or paid
tools; those products are outside this table's scope.

New paid admissions require an exact model match, the canonical verified
provenance, and a valid clock. Missing, altered, future-dated or stale metadata
refuses admission with `PRICE_UNVERIFIED`; there is no zero-price fallback.
Date-only metadata ages conservatively from Pacific midnight, and expires after
seven elapsed days: this table remains valid through **2026-11-02 23:00 PST**.
Refresh and verify the official sources before admitting further paid work.
Already-held calls retain their pinned price for settlement after table expiry.

Verification: the focused `server/adapters/platform-pricing.test.ts` checks all
eight rates, provenance rejection, the expiry boundary, and the test-only policy
guard. It does not compare estimates with provider invoices. Root owns the full
policy integration checks.
