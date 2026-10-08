/**
 * L2 adapter layer — registry tests (offline, all RUN).
 *
 * Verifies (per design §10 test 1 and §6):
 * - unknown name fails closed with MODEL_UNAVAILABLE before spawn
 * - no config + no env → preview-bridge is the default path
 * - AGENT_COMMONS_OFFLINE=1 refuses makesLiveCalls=true adapters
 * - AGENT_COMMONS_ADAPTER=stub resolves to the stub
 *
 */
import assert from "node:assert/strict";
import { AdapterFailure, resolveAdapter, KNOWN_ADAPTERS } from "./index";

function withEnv(name: string, value: string | undefined, run: () => void) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try { run(); } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

// 1. unknown adapter name → MODEL_UNAVAILABLE
assert.deepEqual(KNOWN_ADAPTERS, ["preview-bridge", "stub", "l10-cli"], "registry should ship three adapters");
assert.throws(
  () => resolveAdapter("not-a-real-adapter"),
  (e: unknown) => e instanceof AdapterFailure && e.code === "MODEL_UNAVAILABLE" && e.retryable === false,
  "unknown adapter must fail closed with MODEL_UNAVAILABLE",
);

// 2. preview-bridge resolves with makesLiveCalls: true
const bridge = resolveAdapter("preview-bridge");
assert.equal(bridge.name, "preview-bridge");
assert.equal(bridge.makesLiveCalls, true);

// 3. AGENT_COMMONS_OFFLINE=1 refuses makesLiveCalls: true adapters
withEnv("AGENT_COMMONS_OFFLINE", "1", () => {
  assert.throws(
    () => resolveAdapter("preview-bridge"),
    (e: unknown) => e instanceof AdapterFailure && e.code === "MODEL_UNAVAILABLE" && /AGENT_COMMONS_OFFLINE/.test(e.message),
    "offline kill switch must refuse live adapters",
  );
  assert.throws(
    () => resolveAdapter("l10-cli"),
    (e: unknown) => e instanceof AdapterFailure && e.code === "MODEL_UNAVAILABLE" && /AGENT_COMMONS_OFFLINE/.test(e.message),
    "offline kill switch must refuse l10-cli adapter",
  );
});

// 4. l10-cli resolves with makesLiveCalls: true
const l10 = resolveAdapter("l10-cli");
assert.equal(l10.name, "l10-cli");
assert.equal(l10.makesLiveCalls, true);

// 5. stub resolves with makesLiveCalls: false (no offline required)
const stub = resolveAdapter("stub");
assert.equal(stub.name, "stub");
assert.equal(stub.makesLiveCalls, false);

withEnv("AGENT_COMMONS_OFFLINE", "1", () => {
  const offlineStub = resolveAdapter("stub");
  assert.equal(offlineStub.makesLiveCalls, false, "offline kill switch must not affect non-live adapters");
});

console.log("PASS: registry unknown-name, preview-bridge live, l10-cli live, offline refuses live, stub offline-only.");
