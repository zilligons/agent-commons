import type { PlatformSpendingPolicy } from "./platform-spending";

/** Explicit spending bypass for isolated accounting fixtures; never a production policy. */
export function createFixtureSpendingPolicy(): PlatformSpendingPolicy {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error("FIXTURE_SPENDING_TEST_RUNNER_REQUIRED");
  return Object.freeze({
    admitRun() {},
    reserve() {},
    settle() {},
    usage() { return { fixture: true }; },
  });
}
