/**
 * L10 — adaptive limits, reservations, 250k exhaustion (design v3 §e;
 * L10 seam-review item 1). Type-only module; the runtime state lives in
 * the engine (server/cohort.ts) once the seam delta lands.
 *
 */

import { AdapterFailure } from "./types";

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
  maxCliModelCalls: 1; // off in this slice
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

/**
 * R8 DEFERRAL GATE (rework 3; the review allows the accounting deferral ONLY
 * with this gate): full runtime accounting — settling reservations
 * against measured usage, turn-ladder operation, cohort callers of
 * nextPerTurnLimit/canReserve — is DEFERRED to a later slice. Until it
 * lands, UNACCOUNTED live consumption is explicitly gated: any live L10
 * call is refused with LIMIT_UNSUPPORTED unless the operator has set
 * AGENT_COMMONS_L10_ACCOUNTING=measured, acknowledging that consumption
 * is not being accounted against the 250k run cap by this build.
 *
 * Offline paths (stub, fixture harness) do not call this gate.
 */
export function assertLiveAccountingGate(_env: NodeJS.ProcessEnv = process.env): void {
  throw new AdapterFailure(
    "LIMIT_UNSUPPORTED",
    "LIMIT_UNSUPPORTED: live L10 consumption is unaccounted in this slice " +
    "(reservation settlement and the turn ladder are deferred per the R8 deferral); " +
    "refusing live calls non-bypassably",
    null,
    false,
  );
}

export const L10_TRIAL_TURN_CEILING = 7;

let cachedTrialCap: number | null | undefined = undefined;
let trialTurnCounter = 0;
let bypassCounterCheckForTest = false;

/**
 * C2: assertL10TrialEnabled reads AGENT_COMMONS_L10_TRIAL_TURNS once per process
 * and caches the result. It returns the cap when the value is a decimal integer
 * string in 1..7, nothing else. For missing, empty, non-integer, 0, or >7 values,
 * it throws AdapterFailure("LIMIT_UNSUPPORTED", ...).
 */
export function assertL10TrialEnabled(): number {
  if (cachedTrialCap !== undefined) {
    if (cachedTrialCap === null) {
      throw new AdapterFailure(
        "LIMIT_UNSUPPORTED",
        "L10 trial not enabled: AGENT_COMMONS_L10_TRIAL_TURNS must be an integer between 1 and 7",
        null,
        false,
      );
    }
    return cachedTrialCap;
  }
  const raw = process.env.AGENT_COMMONS_L10_TRIAL_TURNS;
  if (raw === undefined || raw === "" || !/^[1-7]$/.test(raw)) {
    cachedTrialCap = null;
    throw new AdapterFailure(
      "LIMIT_UNSUPPORTED",
      "L10 trial not enabled: AGENT_COMMONS_L10_TRIAL_TURNS must be an integer between 1 and 7",
      null,
      false,
    );
  }
  const val = parseInt(raw, 10);
  if (val < 1 || val > L10_TRIAL_TURN_CEILING) {
    cachedTrialCap = null;
    throw new AdapterFailure(
      "LIMIT_UNSUPPORTED",
      "L10 trial not enabled: AGENT_COMMONS_L10_TRIAL_TURNS must be an integer between 1 and 7",
      null,
      false,
    );
  }
  cachedTrialCap = val;
  return val;
}

/**
 * C2: consumeL10TrialTurn calls assertL10TrialEnabled().
 * If the process-wide counter has already reached the cap, it throws
 * AdapterFailure("LIMIT_UNSUPPORTED", "trial cap of N live turns reached for this server run").
 * Otherwise it increments the counter before returning and returns the new count.
 * Prints ONE line per consumption to stdout:
 * L10 trial live turn <n>/<cap> slot=<slotId>
 */
export function consumeL10TrialTurn(slotId: string): number {
  const cap = assertL10TrialEnabled();
  if (!bypassCounterCheckForTest && trialTurnCounter >= cap) {
    throw new AdapterFailure(
      "LIMIT_UNSUPPORTED",
      `trial cap of ${cap} live turns reached for this server run`,
      null,
      false,
    );
  }
  trialTurnCounter++;
  process.stdout.write(`L10 trial live turn ${trialTurnCounter}/${cap} slot=${slotId}\n`);
  return trialTurnCounter;
}

export function resetL10TrialCounterForTest(options?: { cap?: number | null; counter?: number; bypass?: boolean }): void {
  cachedTrialCap = options?.cap !== undefined ? options.cap : undefined;
  trialTurnCounter = options?.counter ?? 0;
  bypassCounterCheckForTest = options?.bypass ?? false;
}

export function getL10TrialCounterForTest(): number {
  return trialTurnCounter;
}
