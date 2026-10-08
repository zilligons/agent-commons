/**
 * L10 — l10-limits tests (two-pole, per FLEET-SOP §4.6(7)); R8 semantics.
 *
 * Covers (per design v3 §e L124-152 + the R8 deferral note):
 * - boost ladder: two consecutive boosts set hold=true
 * - hold clears ONLY after TWO consecutive valid below-threshold
 *   completions (the slice-1 clear branch was unreachable)
 * - missing/invalid usage: no state change, usageValid=false
 * - reservation 250k exhaustion + boundary
 * - R8 deferral gate: live consumption refused until the operator
 *   acknowledges unaccounted consumption
 *
 */
import assert from "node:assert/strict";
import { nextPerTurnLimit, canReserve, assertLiveAccountingGate, L10_TOKEN_LADDER, L10_MAX_RUN_TOKENS } from "./l10-limits";

async function main() {
  // CONTROL — first turn at the bottom of the ladder stays at 1800 on a
  // valid below-threshold completion.
  const r1 = nextPerTurnLimit({ currentLimit: 1800, boostStreak: 0, nonBoostStreak: 0, hold: false }, { completionTokens: 100 });
  assert.equal(r1.nextLimit, 1800);
  assert.equal(r1.usageValid, true);
  assert.equal(r1.nextNonBoostStreak, 1);

  // CONTROL — first boost advances to 3000, streak 1, no hold yet.
  const r2 = nextPerTurnLimit({ currentLimit: 1800, boostStreak: 0, nonBoostStreak: 0, hold: false }, { completionTokens: 1700 });
  assert.equal(r2.nextLimit, 3000);
  assert.equal(r2.nextBoostStreak, 1);
  assert.equal(r2.nextHold, false, "one boost does not set hold");

  // CONTROL — second consecutive boost sets hold (v3 §e L141).
  const r3 = nextPerTurnLimit({ currentLimit: 3000, boostStreak: 1, nonBoostStreak: 0, hold: false }, { completionTokens: 2700 });
  assert.equal(r3.nextLimit, 6000);
  assert.equal(r3.nextBoostStreak, 2);
  assert.equal(r3.nextHold, true, "two consecutive boosts set hold");

  // MUTANT — hold persists through ONE valid below-threshold completion
  // and clears ONLY after the SECOND (the R8 defect: unreachable before).
  const r4 = nextPerTurnLimit({ currentLimit: 6000, boostStreak: 0, nonBoostStreak: 0, hold: true }, { completionTokens: 1000 });
  assert.equal(r4.nextHold, true, "hold persists through one below-threshold completion");
  assert.equal(r4.nextNonBoostStreak, 1);
  const r5 = nextPerTurnLimit({ currentLimit: 6000, boostStreak: 0, nonBoostStreak: 1, hold: true }, { completionTokens: 1000 });
  assert.equal(r5.nextHold, false, "R8: TWO consecutive valid below-threshold completions CLEAR the hold");
  assert.equal(r5.nextNonBoostStreak, 2);

  // MUTANT — missing usage: no state change, usageValid=false.
  const r6 = nextPerTurnLimit({ currentLimit: 3000, boostStreak: 1, nonBoostStreak: 0, hold: false }, null);
  assert.equal(r6.usageValid, false);
  assert.equal(r6.nextLimit, 3000, "missing usage does not advance the ladder");
  assert.equal(r6.nextBoostStreak, 1, "missing usage does not change the streak");

  // MUTANT — invalid usage (negative, NaN, Infinity) likewise.
  const r7 = nextPerTurnLimit({ currentLimit: 3000, boostStreak: 0, nonBoostStreak: 0, hold: true }, { completionTokens: -5 });
  assert.equal(r7.usageValid, false);
  assert.equal(r7.nextHold, true, "invalid usage does not clear hold");
  const rNaN = nextPerTurnLimit({ currentLimit: 3000, boostStreak: 0, nonBoostStreak: 0, hold: true }, { completionTokens: NaN });
  assert.equal(rNaN.usageValid, false, "NaN usage is invalid");
  const rInf = nextPerTurnLimit({ currentLimit: 3000, boostStreak: 0, nonBoostStreak: 0, hold: true }, { completionTokens: Infinity });
  assert.equal(rInf.usageValid, false, "Infinity usage is invalid");

  // R8 (rework 6): fractional usage (1.5) is invalid and must not change streak state
  const rFrac = nextPerTurnLimit({ currentLimit: 3000, boostStreak: 1, nonBoostStreak: 0, hold: false }, { completionTokens: 1.5 });
  assert.equal(rFrac.usageValid, false, "fractional usage 1.5 is invalid");
  assert.equal(rFrac.nextLimit, 3000, "fractional usage does not advance ladder");
  assert.equal(rFrac.nextBoostStreak, 1, "fractional usage does not change boost streak");
  assert.equal(rFrac.nextNonBoostStreak, 0, "fractional usage does not change nonBoost streak");

  // R8 (rework 5): freeze the ceiling while held (6000 stays 6000 with hold=true).
  const rHeldBoost = nextPerTurnLimit({ currentLimit: 6000, boostStreak: 2, nonBoostStreak: 0, hold: true }, { completionTokens: 5500 });
  assert.equal(rHeldBoost.nextLimit, 6000, "ceiling is frozen at 6000 while held (never advances to 12000)");
  assert.equal(rHeldBoost.nextHold, true, "hold remains true");

  // CONTROL — reservation fits; boundary cap-1 fits.
  assert.equal(canReserve({ chargedTokens: 0, reservedTokens: 0 }, { id: "r1", promptTokensUpper: 600, totalTokens: 2400 }).ok, true);
  assert.equal(canReserve({ chargedTokens: 0, reservedTokens: 0 }, { id: "r2", promptTokensUpper: 1, totalTokens: L10_MAX_RUN_TOKENS - 1 }).ok, true);

  // MUTANT — 250k exhaustion at >= cap; overflow above cap.
  assert.equal(canReserve({ chargedTokens: 0, reservedTokens: 0 }, { id: "r3", promptTokensUpper: 1, totalTokens: L10_MAX_RUN_TOKENS }).ok, false);
  const over = canReserve({ chargedTokens: 0, reservedTokens: 0 }, { id: "r4", promptTokensUpper: 1, totalTokens: L10_MAX_RUN_TOKENS + 1 });
  assert.equal(over.ok, false);
  assert.equal(over.reason, "OVERFLOW");

  // R8 (rework 6): non-bypassable accounting deferral gate: ALWAYS refuses, even with AGENT_COMMONS_L10_ACCOUNTING=measured
  assert.throws(() => assertLiveAccountingGate({ AGENT_COMMONS_L10_ACCOUNTING: "measured" }), /LIMIT_UNSUPPORTED/);
  assert.throws(() => assertLiveAccountingGate({}), /LIMIT_UNSUPPORTED/);
  assert.throws(() => assertLiveAccountingGate({ AGENT_COMMONS_L10_ACCOUNTING: "yes" }), /LIMIT_UNSUPPORTED/);

  // CONTROL — ladder shape.
  assert.deepEqual([...L10_TOKEN_LADDER], [1800, 3000, 6000, 12000, 24000]);

  // R8 (rework 6): engine entry modelCall refuses via non-bypassable assertLiveAccountingGate
  const { modelCall } = await import("../engine");
  const agent = { id: "atlas", name: "Atlas", provider: "OpenAI", model: "gpt5_mini", role: "Protocol architect", color: "green" };
  delete process.env.AGENT_COMMONS_OFFLINE;
  await assert.rejects(async () => {
    await modelCall(agent as any, "prompt", [], null);
  }, (err: any) => err.code === "LIMIT_UNSUPPORTED" || err.message?.includes("LIMIT_UNSUPPORTED"), "engine modelCall refuses via assertLiveAccountingGate");

  console.log("PASS R8: boost/hold (two boosts set hold), hold clears after TWO valid below-threshold completions, missing/invalid/fractional usage no-change, 250k exhaustion, non-bypassable deferral gate, engine entry refusal.");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
