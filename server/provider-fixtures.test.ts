import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const preload = fileURLToPath(new URL("./offline-test-home.mjs", import.meta.url));
const suites = [
  { name: "Anthropic Messages fixtures", files: ["server/adapters/anthropic-messages.test.ts"] },
  { name: "Google Gemini fixtures", files: ["server/adapters/google-gemini.test.ts"] },
  { name: "L10 accounting fixtures", files: ["server/adapters/l10-accounting.test.ts", "server/adapters/l10-accounting-store.test.ts"] },
  { name: "OpenAI Responses fixtures", files: ["server/adapters/openai-responses.test.ts"] },
  { name: "Provider diagnostics fixtures", files: ["server/adapters/provider-diagnostics.test.ts"] },
  { name: "Sol one-use check fixtures", files: ["server/cohort.sol-check.test.ts"] },
  { name: "Archived xAI Responses fixtures", files: ["server/adapters/xai-responses.test.ts"] },
];

// These fixtures belong to the console. The portable package never imports server code or tsx.
for (const suite of suites) {
  test(suite.name, (t) => {
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      NODE_ENV: "test",
      NODE_OPTIONS: "--import=" + preload,
      TSX_TSCONFIG_PATH: fileURLToPath(new URL("../tsconfig.json", import.meta.url)),
      AGENT_COMMONS_OFFLINE: "1",
      AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED: "0",
      PYTHONDONTWRITEBYTECODE: "1",
    };
    const result = spawnSync(process.execPath, ["--import", require.resolve("tsx"), "--test", "--test-reporter=tap", ...suite.files], {
      cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024, env,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
    assert.match(result.stdout, /^# tests [1-9]\d*$/m);
    assert.match(result.stdout, /^# fail 0$/m);
    const summary = result.stdout.match(/^# (?:tests|pass|fail|skipped) \d+$/gm);
    assert(summary);
    t.diagnostic(summary.join("; "));
  });
}
