import test from "node:test";
import assert from "node:assert/strict";
import { networkConsole } from "./network";

function spies() {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    calls.push(`fetch ${String(url)}`);
    throw new Error("stub fetch must not leave the test");
  };
  const lookupImpl = async (host: string) => {
    calls.push(`lookup ${host}`);
    throw new Error("stub lookup must not leave the test");
  };
  return { calls, fetchImpl, lookupImpl };
}

test("network check is offline by default and does not fetch or resolve DNS", async () => {
  const { calls, fetchImpl, lookupImpl } = spies();
  const checks = await networkConsole.check({ env: {}, fetchImpl, lookupImpl });
  assert.equal(calls.length, 0);
  assert.deepEqual(checks.map((row) => row.service), [
    "IAASO register",
    "UUAID registry",
    "agentnet.chat",
    "zilligon.com",
  ]);
  assert.ok(checks.every((row) => row.state === "offline"));
  assert.equal(networkConsole.summary().offline, true);
});

test("AGENT_COMMONS_OFFLINE=0 is the opt-in that reaches the stubs", async () => {
  const { calls, fetchImpl, lookupImpl } = spies();
  const checks = await networkConsole.check({
    env: { AGENT_COMMONS_OFFLINE: "0" },
    fetchImpl,
    lookupImpl,
  });
  assert.deepEqual(calls, [
    "fetch https://authority.iaaso.org/v1/standards",
    "fetch https://api.uuaid.org/health",
    "lookup agentnet.chat",
    "lookup zilligon.com",
  ]);
  assert.ok(checks.every((row) => row.state === "unavailable" || row.state === "dns-unresolved"));
});
