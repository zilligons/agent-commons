import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BIND_ALL_ENV, listenHost, listenOptions } from "./listen_host";

test("loopback is the default, including when preview or a token is set", () => {
  assert.equal(listenHost({}), "127.0.0.1");
  assert.equal(
    listenHost({ AGENT_COMMONS_PRIVATE_PREVIEW: "1" }),
    "127.0.0.1",
  );
  assert.equal(
    listenHost({ AGENT_COMMONS_OPERATOR_TOKEN: "local-test-token-not-a-real-credential" }),
    "127.0.0.1",
  );
  assert.equal(
    listenHost({
      AGENT_COMMONS_PRIVATE_PREVIEW: "1",
      AGENT_COMMONS_OPERATOR_TOKEN: "local-test-token-not-a-real-credential",
    }),
    "127.0.0.1",
  );
});

test("only the exact opt-in binds every interface", () => {
  assert.equal(listenHost({ [BIND_ALL_ENV]: "1" }), "0.0.0.0");
  assert.equal(
    listenHost({
      [BIND_ALL_ENV]: "1",
      AGENT_COMMONS_PRIVATE_PREVIEW: "1",
      AGENT_COMMONS_OPERATOR_TOKEN: "local-test-token-not-a-real-credential",
    }),
    "0.0.0.0",
  );
  for (const value of ["", "0", "true", "yes", "0.0.0.0", "127.0.0.1"]) {
    assert.equal(listenHost({ [BIND_ALL_ENV]: value }), "127.0.0.1", value);
  }
});

test("darwin does not set reusePort, because this Mac returns ENOTSUP", () => {
  const local = listenOptions({}, 5087, "darwin");
  assert.deepEqual(local, { port: 5087, host: "127.0.0.1", reusePort: false });
  const widened = listenOptions({ [BIND_ALL_ENV]: "1" }, 5087, "linux");
  assert.equal(widened.host, "0.0.0.0");
  assert.equal(widened.reusePort, true);
  assert.equal(listenOptions({}, 5000, "linux").reusePort, true);
});

test("app.ts no longer chooses 0.0.0.0 from preview or the operator token", () => {
  // R4 (rework 4, item X1, the security reviewer third look): the B1 rework split
  // bootstrap from app — listenOptions/listen moved to server/app.ts
  // (the bootstrap dynamically imports it AFTER the §c scrub proves
  // clean). The guard must be asserted on the FILE THAT ACTUALLY CALLS
  // listenOptions, not on a leftover import in index.ts. Read both
  // files: index.ts must not contain the binding logic, app.ts must
  // call listenOptions(process.env) and never the 0.0.0.0 / reusePort
  // opt-in patterns.
  const indexSrc = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const appSrc = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
  assert.match(appSrc, /listenOptions\(process\.env\)/,
    "X1: app.ts must call listenOptions(process.env) — that's where the listen now lives");
  assert.doesNotMatch(indexSrc, /listenOptions\(/,
    "X1: index.ts must not call listenOptions (moved to app.ts at the B1 split)");
  assert.doesNotMatch(appSrc, /0\.0\.0\.0/,
    "X1: no literal 0.0.0.0 in app.ts");
  assert.doesNotMatch(appSrc, /reusePort:\s*true/,
    "X1: no reusePort:true literal in app.ts");
  assert.doesNotMatch(appSrc, /AGENT_COMMONS_PRIVATE_PREVIEW\s*===\s*"1"\s*\|\|/,
    "X1: no preview/opt-in pattern in app.ts (the listenOptions function owns the policy)");
});
