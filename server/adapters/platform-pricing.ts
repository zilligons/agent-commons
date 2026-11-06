import { AdapterFailure } from "./types";

export type ModelPrice = Readonly<{
  model: string;
  nanoUsdPerToken: number;
  sourceUrl: string;
  retrievedDate: string;
  verifiedDate: string;
  verified: true;
  basis: string;
}>;
export type VerifiedPrice = ModelPrice & Readonly<{ expiresAtMs: number }>;
export const PRICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Conservative text-token ceilings; one US dollar is one billion nanodollars.
// Pacific date-only retrievals age from midnight, before the actual retrieval.
const prices: Record<string, ModelPrice> = {
  "gpt-6.1-sol": {
    "model": "gpt-6.1-sol",
    "nanoUsdPerToken": 99000,
    "sourceUrl": "https://developers.openai.com/api/docs/pricing",
    "retrievedDate": "2026-10-27",
    "basis": "Highest published text output: long-context Ultrafast90 USD/MTok plus10% regional uplift. Other token categories lower.",
    "verifiedDate": "2026-10-27",
    "verified": true
  },
  "gpt-5.6-terra": {
    "model": "gpt-5.6-terra",
    "nanoUsdPerToken": 19800,
    "sourceUrl": "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
    "retrievedDate": "2026-10-27",
    "basis": "Configured Standard text route only: output12 USD/MTok times long-context1.5 times regional1.1=19.8. Must explicitly request service_tier default; premium modes unsupported by this price.",
    "verifiedDate": "2026-10-27",
    "verified": true
  },
  "claude-fable-5-1": {
    "model": "claude-fable-5-1",
    "nanoUsdPerToken": 55000,
    "sourceUrl": "https://platform.claude.com/docs/en/about-claude/pricing",
    "retrievedDate": "2026-10-27",
    "basis": "Output50 USD/MTok times US-inference1.1; exceeds input/cache-write rates.",
    "verifiedDate": "2026-10-27",
    "verified": true
  },
  "claude-opus-5-5": {
    "model": "claude-opus-5-5",
    "nanoUsdPerToken": 44000,
    "sourceUrl": "https://platform.claude.com/docs/en/about-claude/pricing",
    "retrievedDate": "2026-10-27",
    "basis": "Fast output40 USD/MTok times US-inference1.1; exceeds input/cache-write rates.",
    "verifiedDate": "2026-10-27",
    "verified": true
  },
  "claude-sonnet-5-5": {
    "model": "claude-sonnet-5-5",
    "nanoUsdPerToken": 11000,
    "sourceUrl": "https://platform.claude.com/docs/en/about-claude/pricing",
    "retrievedDate": "2026-10-27",
    "basis": "Output10 USD/MTok times US-inference1.1; exceeds input/cache-write rates.",
    "verifiedDate": "2026-10-27",
    "verified": true
  },
  "gemini-4-argon": {
    "model": "gemini-4-argon",
    "nanoUsdPerToken": 36000,
    "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing",
    "retrievedDate": "2026-10-27",
    "basis": "Highest announced Priority output36 USD/MTok effective Dec1, above current18. Output includes thinking; explicit cache storage and paid tools are not used by fixed transport.",
    "verifiedDate": "2026-10-27",
    "verified": true
  },
  "gemini-3.8-flash": {
    "model": "gemini-3.8-flash",
    "nanoUsdPerToken": 13500,
    "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing",
    "retrievedDate": "2026-10-27",
    "basis": "Highest announced Priority output13.50 USD/MTok effective Jan1, above current6.75. Output includes thinking; explicit cache storage and paid tools are not used by fixed transport.",
    "verifiedDate": "2026-10-27",
    "verified": true
  },
  "grok-4.7": {
    "model": "grok-4.7",
    "nanoUsdPerToken": 12000,
    "sourceUrl": "https://docs.x.ai/developers/pricing",
    "retrievedDate": "2026-10-27",
    "basis": "Historical unregistered route: highest published long-context text output12 USD/MTok.",
    "verifiedDate": "2026-10-27",
    "verified": true
  }
};
for (const row of Object.values(prices)) Object.freeze(row);
export const PLATFORM_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze(prices);

function refuse(): never {
  throw new AdapterFailure("PRICE_UNVERIFIED", "A current verified model price is required for paid admission", null, false);
}

function pacificMidnight(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return refuse();
  const [year, month, day] = date.split("-").map(Number);
  const base = Date.UTC(year, month - 1, day);
  const parsed = new Date(base);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return refuse();
  const zone = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "shortOffset" })
    .formatToParts(new Date(base + 12 * 60 * 60 * 1000)).find(part => part.type === "timeZoneName")?.value;
  const offset = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(zone ?? "");
  if (!offset) return refuse();
  const minutes = (Number(offset[2]) * 60 + Number(offset[3] ?? 0)) * (offset[1] === "+" ? 1 : -1);
  return base - minutes * 60 * 1000;
}

/** Validate fresh admission metadata only. Held calls settle using their pinned price. */
export function validatePriceQuote(value: unknown, nowMs: number = Date.now()): VerifiedPrice {
  if (!value || typeof value !== "object" || !Number.isSafeInteger(nowMs) || nowMs < 0) return refuse();
  const row = value as Partial<ModelPrice>;
  if (typeof row.model !== "string" || !Object.hasOwn(PLATFORM_MODEL_PRICES, row.model)) return refuse();
  const canonical = PLATFORM_MODEL_PRICES[row.model];
  if (row.verified !== true || !Number.isSafeInteger(row.nanoUsdPerToken) || row.nanoUsdPerToken! <= 0 ||
      row.nanoUsdPerToken !== canonical.nanoUsdPerToken || row.sourceUrl !== canonical.sourceUrl ||
      row.retrievedDate !== canonical.retrievedDate || row.verifiedDate !== canonical.verifiedDate || row.basis !== canonical.basis) return refuse();
  const retrievedAt = pacificMidnight(canonical.retrievedDate);
  const verifiedAt = pacificMidnight(canonical.verifiedDate);
  const expiresAtMs = verifiedAt + PRICE_MAX_AGE_MS;
  if (retrievedAt > nowMs || verifiedAt > nowMs || nowMs > expiresAtMs) return refuse();
  return Object.freeze({ ...canonical, expiresAtMs });
}

export function verifiedPrice(model: string, nowMs: number = Date.now()): VerifiedPrice {
  if (typeof model !== "string" || !Object.hasOwn(PLATFORM_MODEL_PRICES, model)) return refuse();
  return validatePriceQuote(PLATFORM_MODEL_PRICES[model], nowMs);
}
