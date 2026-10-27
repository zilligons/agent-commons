import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { PLATFORM_MODEL_PRICES, PRICE_MAX_AGE_MS, validatePriceQuote, verifiedPrice } from "./platform-pricing";
import { createFixtureSpendingPolicy } from "./fixture-spending";

const retrievedAt = Date.parse("2026-10-27T00:00:00-07:00");
const now = retrievedAt + 60 * 60 * 1000;
const refused = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "PRICE_UNVERIFIED";

test("pricing: eight immutable official-source ceilings use integer nanodollars per token", () => {
  const rates = { "gpt-6.1-sol": 99000, "gpt-5.6-terra": 19800, "claude-fable-5-1": 55000,
    "claude-opus-5-5": 44000, "claude-sonnet-5-5": 11000, "gemini-4-argon": 36000,
    "gemini-3.8-flash": 13500, "grok-4.7": 12000 };
  assert.equal(Object.keys(PLATFORM_MODEL_PRICES).length, 8);
  assert(Object.isFrozen(PLATFORM_MODEL_PRICES));
  for (const [model, rate] of Object.entries(rates)) {
    const quote = verifiedPrice(model, now);
    assert.equal(quote.model, model);
    assert.equal(quote.nanoUsdPerToken, rate);
    assert.equal(quote.verified, true);
    assert.equal(quote.retrievedDate, "2026-10-27");
    assert.equal(quote.verifiedDate, "2026-10-27");
    assert.equal(quote.expiresAtMs, retrievedAt + PRICE_MAX_AGE_MS);
    assert.equal(new URL(quote.sourceUrl).protocol, "https:");
    assert(Object.isFrozen(quote));
    assert(Object.isFrozen(PLATFORM_MODEL_PRICES[model]));
  }
});

test("pricing: future retrievals and more than seven elapsed days refuse admission", () => {
  for (const model of Object.keys(PLATFORM_MODEL_PRICES)) {
    assert.throws(() => verifiedPrice(model, retrievedAt - 1), refused);
    assert.equal(verifiedPrice(model, retrievedAt + PRICE_MAX_AGE_MS).model, model);
    assert.throws(() => verifiedPrice(model, retrievedAt + PRICE_MAX_AGE_MS + 1), refused);
  }
});

test("pricing: unknown, aliased and inherited model names have no free fallback", () => {
  for (const model of ["", "unknown", "sol", "gpt-6.1-sol-preview", "__proto__", "constructor", undefined]) {
    assert.throws(() => verifiedPrice(model as string, now), refused);
  }
});

test("pricing: malformed or unverified provenance and altered rates refuse", () => {
  const row = PLATFORM_MODEL_PRICES["gpt-5.6-terra"];
  for (const change of [
    { verified: false }, { verified: undefined }, { sourceUrl: "http://developers.openai.com/api/docs/pricing" },
    { sourceUrl: "https://example.com/pricing" }, { sourceUrl: PLATFORM_MODEL_PRICES["gpt-6.1-sol"].sourceUrl },
    { retrievedDate: "2026-10-28" }, { retrievedDate: "2026-02-30" }, { verifiedDate: undefined },
    { verifiedDate: "2026-10-28" }, { basis: "" }, { nanoUsdPerToken: 0 }, { nanoUsdPerToken: -1 },
    { nanoUsdPerToken: 1.5 }, { nanoUsdPerToken: NaN }, { nanoUsdPerToken: Infinity },
    { nanoUsdPerToken: Number.MAX_SAFE_INTEGER + 1 }, { nanoUsdPerToken: 1 },
  ]) assert.throws(() => validatePriceQuote({ ...row, ...change }, now), refused);
  for (const value of [undefined, null, false, "price", {}]) assert.throws(() => validatePriceQuote(value, now), refused);
});

test("pricing: invalid clocks refuse instead of disabling expiry", () => {
  for (const time of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => verifiedPrice("gpt-6.1-sol", time), refused);
  }
});

test("fixture spending: explicit isolated-test policy has no billing effects", () => {
  const policy = createFixtureSpendingPolicy();
  assert(Object.isFrozen(policy));
  assert.doesNotThrow(() => policy.admitRun({} as any, []));
  assert.doesNotThrow(() => policy.reserve({} as any, {} as any));
  assert.doesNotThrow(() => policy.settle({} as any, {} as any));
  assert.deepEqual(policy.usage(), { fixture: true });
});

test("fixture spending: factory refuses outside the node test runner", () => {
  const require = createRequire(import.meta.url);
  const script = `const {createFixtureSpendingPolicy}=await import(${JSON.stringify(new URL("./fixture-spending.ts", import.meta.url).href)});createFixtureSpendingPolicy();`;
  const child = spawnSync(process.execPath, ["--import", require.resolve("tsx"), "--input-type=module", "--eval", script], {
    env: { PATH: "/usr/bin:/bin", NODE_ENV: "production", TZ: "America/Los_Angeles" },
    encoding: "utf8", maxBuffer: 64 * 1024,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /FIXTURE_SPENDING_TEST_RUNNER_REQUIRED/);
});
