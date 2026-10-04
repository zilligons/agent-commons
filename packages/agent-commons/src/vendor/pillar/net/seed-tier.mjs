/**
 * Seed tiers — what a seed operator EARNS by staying up.
 *
 * A seed is just a carrier server with a public URL (see bin/pillar-seed.mjs).
 * Running one costs money and attention, and until now it bought the operator
 * nothing: the only reward was altruism, which is why the mesh had exactly one
 * seed. This module defines the ladder that turns sustained service into
 * concrete privileges.
 *
 * WHAT COUNTS AS SERVICE (and why it is not self-reported)
 *
 * A seed cannot promote itself by claiming numbers. Every threshold below is
 * measured from observations the REGISTRAR makes against the seed:
 *
 *   - health probes   GET /v1/health on a schedule. Unfakeable: the seed
 *                     either answers within the timeout or it does not.
 *   - round trips     the registrar seals a real envelope to its own probe
 *                     identity, POSTs it THROUGH the seed, then polls the
 *                     seed's inbox for it. Passing means the seed genuinely
 *                     stored and served a signed envelope — the exact job a
 *                     seed exists to do. "A few exchanges" is this counter.
 *
 * The seed's own counters (envelopes relayed, distinct peers) are collected
 * for display via /v1/seed-info but never gate a promotion, because a seed
 * operator controls them.
 *
 * REVOCATION IS EXPIRY
 *
 * A promotion issues a short-TTL tier grant (GRANT_TTL_DAYS). Continued
 * service renews it on the next evaluation; a seed that goes dark simply
 * stops being renewed and its grant lapses. There is no revocation list to
 * distribute, and no way for a stale grant to outlive the service that
 * earned it by more than one TTL.
 */

const DAY = 86_400_000;

/** How long an earned grant lives before it must be re-earned. */
export const GRANT_TTL_DAYS = 14;

/**
 * Consecutive failed probes that knock a seed back to `probation`.
 * Deliberately small: a seed that cannot answer three probes in a row is not
 * one an agent should be told to depend on.
 */
export const DEMOTE_AFTER_FAILURES = 3;

/**
 * The ladder, lowest first. Each rung is cumulative — a seed holds the
 * HIGHEST rung whose every threshold it meets.
 *
 * `grant` names the row of TIER_DEFAULTS (identity/tier.mjs) the operator's
 * own identity is granted while it holds this rung. That is the "extra": the
 * budgets that previously required off-wire foundation review are earned
 * automatically by keeping a seed alive.
 *
 * `priority` marks the rungs whose holders get the reserved admission lane at
 * every carrier that trusts the issuer (see carrier-server.mjs).
 */
export const SEED_TIERS = [
  {
    name: "probation",
    minAgeMs: 0,
    minProbes: 0,
    minUptime: 0,
    minRoundTrips: 0,
    grant: null,
    priority: false,
    /** Sort key for directory.json — lower is listed first. */
    listRank: 3,
    blurb: "enrolled; still proving it stays up",
  },
  {
    name: "steady",
    minAgeMs: DAY,
    minProbes: 20,
    minUptime: 0.95,
    minRoundTrips: 10,
    grant: "supporter",
    priority: false,
    listRank: 2,
    blurb: "up a day, relaying real traffic",
  },
  {
    name: "durable",
    minAgeMs: 7 * DAY,
    minProbes: 150,
    minUptime: 0.99,
    minRoundTrips: 100,
    grant: "org",
    priority: true,
    listRank: 1,
    blurb: "a week of near-perfect uptime",
  },
  {
    name: "anchor",
    minAgeMs: 30 * DAY,
    minProbes: 700,
    minUptime: 0.995,
    minRoundTrips: 1000,
    grant: "enterprise",
    priority: true,
    listRank: 0,
    blurb: "a month; the mesh can be pinned to it",
  },
];

export const SEED_TIER_NAMES = SEED_TIERS.map(t => t.name);

/** Look a rung up by name. Unknown names resolve to `probation` (fail low). */
export function seedTier(name) {
  return SEED_TIERS.find(t => t.name === name) ?? SEED_TIERS[0];
}

/** True when `a` sits at or above `b` on the ladder. */
export function seedTierAtLeast(a, b) {
  return SEED_TIERS.findIndex(t => t.name === a) >= SEED_TIERS.findIndex(t => t.name === b);
}

/**
 * Observed uptime as a fraction, or 0 when nothing has been observed yet.
 * Kept explicit so "no probes" can never read as "100% uptime".
 */
export function uptimeOf(record) {
  const total = record?.probes?.total ?? 0;
  if (total <= 0) return 0;
  return (record.probes.passed ?? 0) / total;
}

/**
 * Decide a seed's rung from the registrar's observation record.
 *
 * @param {object} record  { enrolledAt, probes:{total,passed}, roundTrips:{passed},
 *                           consecutiveFailures }
 * @param {number} now     epoch ms (injectable for tests)
 * @returns {{ tier: string, demoted: boolean, next: string|null, missing: string[],
 *             ageMs: number, uptime: number, roundTrips: number }}
 *          `missing` names the thresholds blocking the NEXT rung, so an
 *          operator can be told what is actually left to do rather than just
 *          "not yet".
 */
export function evaluateSeedTier(record, now = Date.now()) {
  const enrolledMs = Date.parse(record?.enrolledAt ?? "");
  const ageMs = Number.isFinite(enrolledMs) ? Math.max(0, now - enrolledMs) : 0;
  const uptime = uptimeOf(record);
  const probes = record?.probes?.total ?? 0;
  const roundTrips = record?.roundTrips?.passed ?? 0;
  const failures = record?.consecutiveFailures ?? 0;

  // A currently-failing seed is not a seed anyone should be routed to, no
  // matter how good its history looks.
  if (failures >= DEMOTE_AFTER_FAILURES) {
    return {
      tier: "probation",
      demoted: true,
      next: null,
      missing: [`answer a health probe (${failures} consecutive failures)`],
      ageMs, uptime, roundTrips,
    };
  }

  const meets = (t) =>
    ageMs >= t.minAgeMs &&
    probes >= t.minProbes &&
    uptime >= t.minUptime &&
    roundTrips >= t.minRoundTrips;

  let held = SEED_TIERS[0];
  for (const t of SEED_TIERS) {
    if (meets(t)) held = t; else break;
  }
  const nextRung = SEED_TIERS[SEED_TIERS.indexOf(held) + 1] ?? null;

  const missing = [];
  if (nextRung) {
    if (ageMs < nextRung.minAgeMs) {
      missing.push(`${Math.ceil((nextRung.minAgeMs - ageMs) / DAY)}d more enrolled`);
    }
    if (probes < nextRung.minProbes) missing.push(`${nextRung.minProbes - probes} more health probes`);
    if (uptime < nextRung.minUptime) missing.push(`uptime ${(uptime * 100).toFixed(1)}% < ${(nextRung.minUptime * 100).toFixed(1)}%`);
    if (roundTrips < nextRung.minRoundTrips) missing.push(`${nextRung.minRoundTrips - roundTrips} more relay round-trips`);
  }

  return { tier: held.name, demoted: false, next: nextRung?.name ?? null, missing, ageMs, uptime, roundTrips };
}
