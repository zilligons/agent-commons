/**
 * L10 — adaptive limits, reservations, 250k exhaustion (design v3 §e;
 * L10 seam-review item 1). Pure limit calculations live here; durable
 * admission, usage receipts and per-agent state live in l10-accounting.ts
 * and l10-accounting-store.ts.
 *
 */

import { assertAccountingPermit } from "./l10-admission";

export const L10_TOKEN_LADDER = Object.freeze([1800, 3000, 6000, 12000, 24000] as const);
export const L10_TURN_LADDER_MULTIPLIER = Object.freeze([1, 2, 3] as const);
export const L10_MAX_COMPLETION_TOKENS = 24000;
export const L10_MAX_TURNS = 84;
export const L10_MAX_RUN_TOKENS = 250_000;
export const L10_MAX_ATTEMPTS_PER_HOUR = 100;
export const L10_MAX_TURN_SECONDS = 80;
export const L10_MAX_SESSION_SECONDS = 480;
export const L10_MAX_OUTPUT_BYTES = 64_000;
export const L10_BOOST_THRESHOLD_FRACTION = 0.8; // 80% of the granted completion ceiling

export type Limits = {
  maxCompletionTokens: number;
  maxTotalTokens: number;
  maxCliModelCalls: 1; // reservation covers one bounded adapter invocation
};

export type Reservation = {
  id: string;
  promptTokensUpper: number;
  totalTokens: number;
};

/**
 * R8 (rework 3): apply the boost ladder given a completed turn's
 * VALIDATED usage. v3 §e semantics:
 *   - a turn whose completion used >= 80% of the granted ceiling is a
 *     boost-eligible turn: advance one step on the ladder; TWO
 *     consecutive boosts set hold=true.
 *   - hold=true freezes the limit; it clears ONLY after TWO consecutive
 *     valid below-threshold completions (nonBoostStreak reaches 2). The
 *     slice-1 implementation returned hold=true unconditionally for
 *     every held state, so the clear branch was unreachable — the
 *     earlier measured defect.
 *   - missing/invalid usage is NOT a valid completion: it neither boosts
 *     nor counts toward clearing the hold (state carries through
 *     unchanged; the caller decides the retry/blocking policy).
 */
export type L10TurnUsage = { completionTokens: number } | null;

export function nextPerTurnLimit(state: {
  currentLimit: number;
  boostStreak: number;
  nonBoostStreak: number;
  hold: boolean;
}, usage: L10TurnUsage): {
  nextLimit: number;
  nextBoostStreak: number;
  nextNonBoostStreak: number;
  nextHold: boolean;
  usageValid: boolean;
} {
  if (
    usage === null ||
    typeof usage.completionTokens !== "number" ||
    !Number.isSafeInteger(usage.completionTokens) ||
    usage.completionTokens < 0
  ) {
    // Missing/invalid usage (null, NaN, Infinity, negative, non-integer): no state change, flagged invalid.
    return {
      nextLimit: state.currentLimit,
      nextBoostStreak: state.boostStreak,
      nextNonBoostStreak: state.nonBoostStreak,
      nextHold: state.hold,
      usageValid: false,
    };
  }
  const threshold = state.currentLimit * L10_BOOST_THRESHOLD_FRACTION;
  if (usage.completionTokens < threshold) {
    // Valid below-threshold completion. In hold: count toward the
    // two-completion clear; otherwise just reset the boost streak.
    const newNonBoostStreak = state.nonBoostStreak + 1;
    const clearHold = state.hold && newNonBoostStreak >= 2;
    return {
      nextLimit: state.currentLimit,
      nextBoostStreak: 0,
      nextNonBoostStreak: newNonBoostStreak,
      nextHold: state.hold && !clearHold,
      usageValid: true,
    };
  }
  // Valid boost-eligible turn.
  // R8 (rework 5): freeze the ceiling while held (6000 stays 6000 with hold=true).
  if (state.hold) {
    return {
      nextLimit: state.currentLimit,
      nextBoostStreak: state.boostStreak,
      nextNonBoostStreak: 0,
      nextHold: true,
      usageValid: true,
    };
  }
  // Unheld: advance the limit one step on the ladder.
  const idx = L10_TOKEN_LADDER.indexOf(state.currentLimit as typeof L10_TOKEN_LADDER[number]);
  const nextIdx = idx === -1 ? 0 : Math.min(idx + 1, L10_TOKEN_LADDER.length - 1);
  const nextLimit = L10_TOKEN_LADDER[nextIdx];
  const newStreak = state.boostStreak + 1;
  return {
    nextLimit,
    nextBoostStreak: newStreak,
    nextNonBoostStreak: 0,
    nextHold: newStreak >= 2,
    usageValid: true,
  };
}

/**
 * Reservation math: given the per-run state, can the next prompt+max-gen
 * reservation fit? The reservation covers the FULL prompt plus a proven
 * bound for all generated, hidden and CLI-internal tokens.
 */
export function canReserve(state: { chargedTokens: number; reservedTokens: number }, want: Reservation): {
  ok: boolean;
  reason?: "INSUFFICIENT_CAPACITY" | "OVERFLOW";
} {
  // 250k exhaustion: a run is exhausted at exactly the cap (>=, not >),
  // because the reservation covers the FULL prompt plus a proven bound
  // for ALL generated/hidden/CLI-internal tokens. Allowing the cap to
  // be hit exactly would leave no headroom for the LAST prompt's
  // generation; we refuse earlier to keep the run under the cap.
  if (want.totalTokens > L10_MAX_RUN_TOKENS) return { ok: false, reason: "OVERFLOW" };
  if (state.chargedTokens + state.reservedTokens + want.totalTokens >= L10_MAX_RUN_TOKENS) {
    return { ok: false, reason: "INSUFFICIENT_CAPACITY" };
  }
  return { ok: true };
}

/** Live calls require a reservation-backed permit issued by accounting admission. */
export function assertLiveAccountingGate(permit?: unknown): void {
  assertAccountingPermit(permit);
}
